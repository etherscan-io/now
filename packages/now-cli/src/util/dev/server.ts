import ms from 'ms';
import url from 'url';
import http from 'http';
import fs from 'fs-extra';
import chalk from 'chalk';
import plural from 'pluralize';
import rawBody from 'raw-body';
import listen from 'async-listen';
import minimatch from 'minimatch';
import httpProxy from 'http-proxy';
import { randomBytes } from 'crypto';
import serveHandler from 'serve-handler';
import { watch, FSWatcher } from 'chokidar';
import { parse as parseDotenv } from 'dotenv';
import { basename, dirname, extname, join } from 'path';
import directoryTemplate from 'serve-handler/src/directory';

import {
  Builder,
  FileFsRef,
  PackageJson,
  detectBuilders,
  detectRoutes,
} from '@now/build-utils';

import { once } from '../once';
import link from '../output/link';
import { Output } from '../output';
import { relative } from '../path-helpers';
import { getDistTag } from '../get-dist-tag';
import getNowConfigPath from '../config/local-path';
import { MissingDotenvVarsError } from '../errors-ts';
import { version as cliVersion } from '../../../package.json';
import {
  createIgnore,
  staticFiles as getFiles,
  getAllProjectFiles,
} from '../get-files';
import { validateNowConfigBuilds, validateNowConfigRoutes } from './validate';

import isURL from './is-url';
import devRouter from './router';
import getMimeType from './mime-type';
import { getYarnPath } from './yarn-installer';
import { executeBuild, getBuildMatches, shutdownBuilder } from './builder';
import { generateErrorMessage, generateHttpStatusDescription } from './errors';
import {
  builderDirPromise,
  installBuilders,
  updateBuilders,
} from './builder-cache';

// HTML templates
import errorTemplate from './templates/error';
import errorTemplateBase from './templates/error_base';
import errorTemplate404 from './templates/error_404';
import errorTemplate502 from './templates/error_502';
import redirectTemplate from './templates/redirect';

import {
  EnvConfig,
  NowConfig,
  DevServerOptions,
  BuildMatch,
  BuildResult,
  BuilderInputs,
  BuilderOutput,
  HttpHandler,
  InvokePayload,
  InvokeResult,
  ListenSpec,
  RouteConfig,
  RouteResult,
} from './types';

interface FSEvent {
  type: string;
  path: string;
}

interface NodeRequire {
  (id: string): any;
  cache: {
    [name: string]: any;
  };
}

declare const __non_webpack_require__: NodeRequire;

function sortBuilders(buildA: Builder, buildB: Builder) {
  if (buildA && buildA.use && buildA.use.startsWith('@now/static-build')) {
    return 1;
  }

  if (buildB && buildB.use && buildB.use.startsWith('@now/static-build')) {
    return -1;
  }

  return 0;
}

export default class DevServer {
  public cwd: string;
  public debug: boolean;
  public output: Output;
  public env: EnvConfig;
  public buildEnv: EnvConfig;
  public files: BuilderInputs;
  public yarnPath: string;
  public address: string;

  private cachedNowConfig: NowConfig | null;
  private server: http.Server;
  private stopping: boolean;
  private serverUrlPrinted: boolean;
  private buildMatches: Map<string, BuildMatch>;
  private inProgressBuilds: Map<string, Promise<void>>;
  private watcher?: FSWatcher;
  private watchAggregationId: NodeJS.Timer | null;
  private watchAggregationEvents: FSEvent[];
  private watchAggregationTimeout: number;
  private filter: (path: string) => boolean;
  private podId: string;

  private getNowConfigPromise: Promise<NowConfig> | null;
  private blockingBuildsPromise: Promise<void> | null;
  private updateBuildersPromise: Promise<void> | null;

  constructor(cwd: string, options: DevServerOptions) {
    this.cwd = cwd;
    this.debug = options.debug;
    this.output = options.output;
    this.env = {};
    this.buildEnv = {};
    this.files = {};
    this.address = '';

    // This gets updated when `start()` is invoked
    this.yarnPath = '/';

    this.cachedNowConfig = null;
    this.server = http.createServer(this.devServerHandler);
    this.serverUrlPrinted = false;
    this.stopping = false;
    this.buildMatches = new Map();
    this.inProgressBuilds = new Map();

    this.getNowConfigPromise = null;
    this.blockingBuildsPromise = null;
    this.updateBuildersPromise = null;

    this.watchAggregationId = null;
    this.watchAggregationEvents = [];
    this.watchAggregationTimeout = 500;

    this.filter = path => Boolean(path);
    this.podId = Math.random()
      .toString(32)
      .slice(-5);
  }

  async exit(code = 1) {
    await this.stop(code);
    process.exit(code);
  }

  enqueueFsEvent(type: string, path: string): void {
    this.watchAggregationEvents.push({ type, path });
    if (this.watchAggregationId === null) {
      this.watchAggregationId = setTimeout(() => {
        const events = this.watchAggregationEvents.slice();
        this.watchAggregationEvents.length = 0;
        this.watchAggregationId = null;
        this.handleFilesystemEvents(events);
      }, this.watchAggregationTimeout);
    }
  }

  async handleFilesystemEvents(events: FSEvent[]): Promise<void> {
    this.output.debug(`Filesystem watcher notified of ${events.length} events`);

    const filesChanged: Set<string> = new Set();
    const filesRemoved: Set<string> = new Set();

    const distPaths: string[] = [];

    for (const buildMatch of this.buildMatches.values()) {
      for (const buildResult of buildMatch.buildResults.values()) {
        if (buildResult.distPath) {
          distPaths.push(buildResult.distPath);
        }
      }
    }

    events = events.filter(event =>
      distPaths.every(distPath => !event.path.startsWith(distPath))
    );

    // First, update the `files` mapping of source files
    for (const event of events) {
      if (event.type === 'add') {
        await this.handleFileCreated(event.path, filesChanged, filesRemoved);
      } else if (event.type === 'unlink') {
        this.handleFileDeleted(event.path, filesChanged, filesRemoved);
      } else if (event.type === 'change') {
        await this.handleFileModified(event.path, filesChanged, filesRemoved);
      }
    }

    // Update the build matches in case an entrypoint was created or deleted
    const nowConfig = await this.getNowConfig(false);
    await this.updateBuildMatches(nowConfig);

    const filesChangedArray = [...filesChanged];
    const filesRemovedArray = [...filesRemoved];

    // Trigger rebuilds of any existing builds that are dependent
    // on one of the files that has changed
    const needsRebuild: Map<
      BuildResult,
      [string | null, BuildMatch]
    > = new Map();

    for (const match of this.buildMatches.values()) {
      for (const [requestPath, result] of match.buildResults) {
        // If the `BuildResult` is already queued for a re-build,
        // then we can skip subsequent lookups
        if (needsRebuild.has(result)) continue;

        if (Array.isArray(result.watch)) {
          for (const pattern of result.watch) {
            if (
              minimatches(filesChangedArray, pattern) ||
              minimatches(filesRemovedArray, pattern)
            ) {
              needsRebuild.set(result, [requestPath, match]);
              break;
            }
          }
        }
      }
    }

    if (needsRebuild.size > 0) {
      this.output.debug(`Triggering ${needsRebuild.size} rebuilds`);
      if (filesChangedArray.length > 0) {
        this.output.debug(`Files changed: ${filesChangedArray.join(', ')}`);
      }
      if (filesRemovedArray.length > 0) {
        this.output.debug(`Files removed: ${filesRemovedArray.join(', ')}`);
      }
      for (const [result, [requestPath, match]] of needsRebuild) {
        if (
          requestPath === null ||
          (await shouldServe(match, this.files, requestPath, this))
        ) {
          this.triggerBuild(
            match,
            requestPath,
            null,
            result,
            filesChangedArray,
            filesRemovedArray
          ).catch((err: Error) => {
            this.output.warn(
              `An error occurred while rebuilding ${match.src}:`
            );
            console.error(err.stack);
          });
        } else {
          this.output.debug(
            `Not rebuilding because \`shouldServe()\` returned \`false\` for "${match.use}" request path "${requestPath}"`
          );
        }
      }
    }
  }

  async handleFileCreated(
    fsPath: string,
    changed: Set<string>,
    removed: Set<string>
  ): Promise<void> {
    const name = relative(this.cwd, fsPath);
    try {
      this.files[name] = await FileFsRef.fromFsPath({ fsPath });
      fileChanged(name, changed, removed);
      this.output.debug(`File created: ${name}`);
    } catch (err) {
      if (err.code === 'ENOENT') {
        this.output.debug(`File created, but has since been deleted: ${name}`);
        fileRemoved(name, this.files, changed, removed);
      } else {
        throw err;
      }
    }
  }

  handleFileDeleted(
    fsPath: string,
    changed: Set<string>,
    removed: Set<string>
  ): void {
    const name = relative(this.cwd, fsPath);
    this.output.debug(`File deleted: ${name}`);
    fileRemoved(name, this.files, changed, removed);
  }

  async handleFileModified(
    fsPath: string,
    changed: Set<string>,
    removed: Set<string>
  ): Promise<void> {
    const name = relative(this.cwd, fsPath);
    try {
      this.files[name] = await FileFsRef.fromFsPath({ fsPath });
      fileChanged(name, changed, removed);
      this.output.debug(`File modified: ${name}`);
    } catch (err) {
      if (err.code === 'ENOENT') {
        this.output.debug(`File modified, but has since been deleted: ${name}`);
        fileRemoved(name, this.files, changed, removed);
      } else {
        throw err;
      }
    }
  }

  async updateBuildMatches(
    nowConfig: NowConfig,
    isInitial = false
  ): Promise<void> {
    const fileList = this.resolveBuildFiles(this.files);
    const matches = await getBuildMatches(
      nowConfig,
      this.cwd,
      this.yarnPath,
      this.output,
      fileList
    );
    const sources = matches.map(m => m.src);

    if (isInitial && fileList.length === 0) {
      this.output.warn(
        'There are no files (or only files starting with a dot) inside your deployment.'
      );
    }

    // Delete build matches that no longer exists
    const ops: Promise<void>[] = [];
    for (const src of this.buildMatches.keys()) {
      if (!sources.includes(src)) {
        this.output.debug(`Removing build match for "${src}"`);
        const match = this.buildMatches.get(src);
        if (match) {
          ops.push(shutdownBuilder(match, this.output));
        }
        this.buildMatches.delete(src);
      }
    }
    await Promise.all(ops);

    // Add the new matches to the `buildMatches` map
    const blockingBuilds: Promise<void>[] = [];
    for (const match of matches) {
      const currentMatch = this.buildMatches.get(match.src);
      if (!currentMatch || currentMatch.use !== match.use) {
        this.output.debug(`Adding build match for "${match.src}"`);
        this.buildMatches.set(match.src, match);
        if (!isInitial && needsBlockingBuild(match)) {
          const buildPromise = executeBuild(
            nowConfig,
            this,
            this.files,
            match,
            null,
            false
          );
          blockingBuilds.push(buildPromise);
        }
      }
    }

    if (blockingBuilds.length > 0) {
      const cleanup = () => {
        this.blockingBuildsPromise = null;
      };
      this.blockingBuildsPromise = Promise.all(blockingBuilds)
        .then(cleanup)
        .catch(cleanup);
    }

    // Sort build matches to make sure `@now/static-build` is always last
    this.buildMatches = new Map(
      [...this.buildMatches.entries()].sort((matchA, matchB) => {
        return sortBuilders(matchA[1] as Builder, matchB[1] as Builder);
      })
    );
  }

  async invalidateBuildMatches(
    nowConfig: NowConfig,
    updatedBuilders: string[]
  ): Promise<void> {
    if (updatedBuilders.length === 0) {
      this.output.debug('No builders were updated');
      return;
    }

    const _require =
      typeof __non_webpack_require__ === 'function'
        ? __non_webpack_require__
        : require;

    // The `require()` cache for the builder's assets must be purged
    const builderDir = await builderDirPromise;
    const updatedBuilderPaths = updatedBuilders.map(b =>
      join(builderDir, 'node_modules', b)
    );
    for (const id of Object.keys(_require.cache)) {
      for (const path of updatedBuilderPaths) {
        if (id.startsWith(path)) {
          this.output.debug(`Purging require cache for "${id}"`);
          delete _require.cache[id];
        }
      }
    }

    // Delete any build matches that have the old builder required already
    for (const buildMatch of this.buildMatches.values()) {
      const {
        src,
        builderWithPkg: { package: pkg },
      } = buildMatch;
      if (pkg.name === '@now/static') continue;
      if (pkg.name && updatedBuilders.includes(pkg.name)) {
        shutdownBuilder(buildMatch, this.output);
        this.buildMatches.delete(src);
        this.output.debug(`Invalidated build match for "${src}"`);
      }
    }

    // Re-add the build matches that were just removed, but with the new builder
    await this.updateBuildMatches(nowConfig);
  }

  async getLocalEnv(fileName: string, base?: EnvConfig): Promise<EnvConfig> {
    // TODO: use the file watcher to only invalidate the env `dotfile`
    // once a change to the `fileName` occurs
    const filePath = join(this.cwd, fileName);
    let env: EnvConfig = {};
    try {
      const dotenv = await fs.readFile(filePath, 'utf8');
      this.output.debug(`Using local env: ${filePath}`);
      env = parseDotenv(dotenv);
    } catch (err) {
      if (err.code !== 'ENOENT') {
        throw err;
      }
    }
    try {
      return this.validateEnvConfig(fileName, base || {}, env);
    } catch (err) {
      if (err instanceof MissingDotenvVarsError) {
        this.output.error(err.message);
        await this.exit();
      } else {
        throw err;
      }
    }
    return {};
  }

  async getNowConfig(
    canUseCache: boolean = true,
    isInitialLoad: boolean = false
  ): Promise<NowConfig> {
    if (this.getNowConfigPromise) {
      return this.getNowConfigPromise;
    }
    this.getNowConfigPromise = this._getNowConfig(canUseCache, isInitialLoad);
    try {
      return await this.getNowConfigPromise;
    } finally {
      this.getNowConfigPromise = null;
    }
  }

  async _getNowConfig(
    canUseCache: boolean = true,
    isInitialLoad: boolean = false
  ): Promise<NowConfig> {
    if (canUseCache && this.cachedNowConfig) {
      this.output.debug('Using cached `now.json` config');
      return this.cachedNowConfig;
    }

    const pkg = await this.getPackageJson();

    // The default empty `now.json` is used to serve all files as static
    // when no `now.json` is present
    let config: NowConfig = this.cachedNowConfig || { version: 2 };

    // We need to delete these properties for zero config to work
    // with file changes
    if (this.cachedNowConfig) {
      delete this.cachedNowConfig.builds;
      delete this.cachedNowConfig.routes;
    }

    try {
      this.output.debug('Reading `now.json` file');
      const nowConfigPath = getNowConfigPath(this.cwd);
      config = JSON.parse(await fs.readFile(nowConfigPath, 'utf8'));
    } catch (err) {
      if (err.code === 'ENOENT') {
        this.output.debug('No `now.json` file present');
      } else if (err.name === 'SyntaxError') {
        this.output.warn(
          `There is a syntax error in the \`now.json\` file: ${err.message}`
        );
      } else {
        throw err;
      }
    }

    // no builds -> zero config
    if (!config.builds || config.builds.length === 0) {
      const allFiles = await getAllProjectFiles(this.cwd, this.output);
      const files = allFiles.filter(this.filter);

      this.output.debug(
        `Found ${allFiles.length} and ` +
          `filtered out ${allFiles.length - files.length} files`
      );

      const { builders, warnings, errors } = await detectBuilders(files, pkg, {
        tag: getDistTag(cliVersion) === 'canary' ? 'canary' : 'latest',
      });

      if (errors) {
        this.output.error(errors[0].message);
        await this.exit();
      }

      if (warnings && warnings.length > 0) {
        warnings.forEach(warning => this.output.warn(warning.message));
      }

      if (builders) {
        const { defaultRoutes, error: routesError } = await detectRoutes(
          files,
          builders
        );

        config.builds = config.builds || [];
        config.builds.push(...builders);

        if (routesError) {
          this.output.error(routesError.message);
          await this.exit();
        } else {
          config.routes = config.routes || [];
          config.routes.push(...(defaultRoutes as RouteConfig[]));
        }
      }
    }

    if (!config.builds || config.builds.length === 0) {
      if (isInitialLoad) {
        this.output.note(`Serving all files as static`);
      }
    } else if (Array.isArray(config.builds)) {
      // `@now/static-build` needs to be the last builder
      // since it might catch all other requests
      config.builds.sort(sortBuilders);
    }

    await this.validateNowConfig(config);

    this.cachedNowConfig = config;
    return config;
  }

  async getPackageJson(): Promise<PackageJson | null> {
    const pkgPath = join(this.cwd, 'package.json');
    let pkg: PackageJson | null = null;

    this.output.debug('Reading `package.json` file');

    try {
      pkg = JSON.parse(await fs.readFile(pkgPath, 'utf8'));
    } catch (err) {
      if (err.code === 'ENOENT') {
        this.output.debug('No `package.json` file present');
      } else if (err.name === 'SyntaxError') {
        this.output.warn(
          `There is a syntax error in the \`package.json\` file: ${err.message}`
        );
      } else {
        throw err;
      }
    }

    return pkg;
  }

  async validateNowConfig(config: NowConfig): Promise<void> {
    if (config.version === 1) {
      this.output.error('Only `version: 2` is supported by `now dev`');
      await this.exit(1);
    }

    const buildsError = validateNowConfigBuilds(config);

    if (buildsError) {
      this.output.error(buildsError);
      await this.exit(1);
    }

    const routesError = validateNowConfigRoutes(config);

    if (routesError) {
      this.output.error(routesError);
      await this.exit(1);
    }
  }

  validateEnvConfig(
    type: string,
    env: EnvConfig = {},
    localEnv: EnvConfig = {}
  ): EnvConfig {
    // Validate if there are any missing env vars defined in `now.json`,
    // but not in the `.env` / `.build.env` file
    const missing: string[] = Object.entries(env)
      .filter(
        ([name, value]) =>
          typeof value === 'string' &&
          value.startsWith('@') &&
          !hasOwnProperty(localEnv, name)
      )
      .map(([name]) => name);

    if (missing.length > 0) {
      throw new MissingDotenvVarsError(type, missing);
    }

    const merged: EnvConfig = { ...env, ...localEnv };

    // Validate that the env var name matches what AWS Lambda allows:
    //   - https://docs.aws.amazon.com/lambda/latest/dg/env_variables.html
    let hasInvalidName = false;
    for (const key of Object.keys(merged)) {
      if (!/^[a-zA-Z][a-zA-Z0-9_]*$/.test(key)) {
        this.output.warn(
          `Ignoring ${type
            .split('.')
            .slice(1)
            .reverse()
            .join(' ')} var ${JSON.stringify(key)} because name is invalid`
        );
        hasInvalidName = true;
        delete merged[key];
      }
    }
    if (hasInvalidName) {
      this.output.log(
        'Env var names must start with letters, and can only contain alphanumeric characters and underscores'
      );
    }

    return merged;
  }

  /**
   * Create an array of from builder inputs
   * and filter them
   */
  resolveBuildFiles(files: BuilderInputs) {
    return Object.keys(files).filter(this.filter);
  }

  /**
   * Launches the `now dev` server.
   */
  async start(...listenSpec: ListenSpec): Promise<void> {
    if (!fs.existsSync(this.cwd)) {
      throw new Error(`${chalk.bold(this.cwd)} doesn't exist`);
    }

    if (!fs.lstatSync(this.cwd).isDirectory()) {
      throw new Error(`${chalk.bold(this.cwd)} is not a directory`);
    }

    this.yarnPath = await getYarnPath(this.output);

    const ig = await createIgnore(join(this.cwd, '.nowignore'));
    this.filter = ig.createFilter();

    // Retrieve the path of the native module
    const nowConfig = await this.getNowConfig(false, true);
    const nowConfigBuild = nowConfig.build || {};
    const [env, buildEnv] = await Promise.all([
      this.getLocalEnv('.env', nowConfig.env),
      this.getLocalEnv('.env.build', nowConfigBuild.env),
    ]);
    Object.assign(process.env, buildEnv);
    this.env = env;
    this.buildEnv = buildEnv;

    const opts = { output: this.output, isBuilds: true };
    const files = await getFiles(this.cwd, nowConfig, opts);
    const results: { [filePath: string]: FileFsRef } = {};
    for (const fsPath of files) {
      const path = relative(this.cwd, fsPath);
      const { mode } = await fs.stat(fsPath);
      results[path] = new FileFsRef({ mode, fsPath });
    }
    this.files = results;

    const builders: Set<string> = new Set(
      (nowConfig.builds || [])
        .filter((b: Builder) => b.use)
        .map((b: Builder) => b.use as string)
    );

    await installBuilders(builders, this.yarnPath, this.output);
    await this.updateBuildMatches(nowConfig, true);

    // Updating builders happens lazily, and any builders that were updated
    // get their "build matches" invalidated so that the new version is used.
    this.updateBuildersPromise = updateBuilders(
      builders,
      this.yarnPath,
      this.output
    )
      .then(updatedBuilders => {
        this.updateBuildersPromise = null;
        this.invalidateBuildMatches(nowConfig, updatedBuilders);
      })
      .catch(err => {
        this.updateBuildersPromise = null;
        this.output.error(`Failed to update builders: ${err.message}`);
        this.output.debug(err.stack);
      });

    // Now Builders that do not define a `shouldServe()` function need to be
    // executed at boot-up time in order to get the initial assets and/or routes
    // that can be served by the builder.
    const blockingBuilds = Array.from(this.buildMatches.values()).filter(
      needsBlockingBuild
    );
    if (blockingBuilds.length > 0) {
      this.output.log(
        `Creating initial ${plural('build', blockingBuilds.length)}`
      );

      for (const match of blockingBuilds) {
        await executeBuild(nowConfig, this, this.files, match, null, true);
      }

      this.output.success('Build completed');
    }

    // Start the filesystem watcher
    this.watcher = watch(this.cwd, {
      ignored: (path: string) => !this.filter(path),
      ignoreInitial: true,
      useFsEvents: false,
      usePolling: false,
      persistent: true,
    });
    this.watcher.on('add', (path: string) => {
      this.enqueueFsEvent('add', path);
    });
    this.watcher.on('change', (path: string) => {
      this.enqueueFsEvent('change', path);
    });
    this.watcher.on('unlink', (path: string) => {
      this.enqueueFsEvent('unlink', path);
    });
    this.watcher.on('error', (err: Error) => {
      this.output.error(`Watcher error: ${err}`);
    });

    // Wait for "ready" event of the watcher
    await once(this.watcher, 'ready');

    let address: string | null = null;
    while (typeof address !== 'string') {
      try {
        address = await listen(this.server, ...listenSpec);
      } catch (err) {
        this.output.debug(`Got listen error: ${err.code}`);
        if (err.code === 'EADDRINUSE') {
          if (typeof listenSpec[0] === 'number') {
            // Increase port and try again
            this.output.note(
              `Requested port ${chalk.yellow(
                String(listenSpec[0])
              )} is already in use`
            );
            listenSpec[0]++;
          } else {
            this.output.error(
              `Requested socket ${chalk.cyan(listenSpec[0])} is already in use`
            );
            process.exit(1);
          }
        } else {
          throw err;
        }
      }
    }

    this.address = address
      .replace('[::]', 'localhost')
      .replace('127.0.0.1', 'localhost');

    this.output.ready(`Available at ${link(this.address)}`);
    this.serverUrlPrinted = true;
  }

  /**
   * Shuts down the `now dev` server, and cleans up any temporary resources.
   */
  async stop(exitCode?: number): Promise<void> {
    if (this.stopping) return;

    this.stopping = true;

    if (this.serverUrlPrinted) {
      // This makes it look cleaner
      process.stdout.write('\n');
      this.output.log(`Stopping ${chalk.bold('`now dev`')} server`);
    }

    const ops: Promise<void>[] = [];

    for (const match of this.buildMatches.values()) {
      ops.push(shutdownBuilder(match, this.output));
    }

    ops.push(close(this.server));

    if (this.watcher) {
      this.output.debug(`Closing file watcher`);
      this.watcher.close();
    }

    if (this.updateBuildersPromise) {
      this.output.debug(`Waiting for builders update to complete`);
      ops.push(this.updateBuildersPromise);
    }

    try {
      await Promise.all(ops);
    } catch (err) {
      // Node 8 doesn't have a code for that error
      if (
        err.code === 'ERR_SERVER_NOT_RUNNING' ||
        err.message === 'Not running'
      ) {
        process.exit(exitCode || 0);
      } else {
        throw err;
      }
    }
  }

  shouldRebuild(req: http.IncomingMessage): boolean {
    return (
      req.headers.pragma === 'no-cache' ||
      req.headers['cache-control'] === 'no-cache'
    );
  }

  async send404(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    nowRequestId: string
  ): Promise<void> {
    return this.sendError(req, res, nowRequestId, 'FILE_NOT_FOUND', 404);
  }

  async sendError(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    nowRequestId: string,
    errorCode?: string,
    statusCode: number = 500
  ): Promise<void> {
    res.statusCode = statusCode;
    this.setResponseHeaders(res, nowRequestId);

    const http_status_description = generateHttpStatusDescription(statusCode);
    const error_code = errorCode || http_status_description;
    const errorMessage = generateErrorMessage(statusCode, error_code);

    let body: string;
    const { accept = 'text/plain' } = req.headers;
    if (accept.includes('json')) {
      res.setHeader('content-type', 'application/json');
      const json = JSON.stringify({
        error: {
          code: statusCode,
          message: errorMessage.title,
        },
      });
      body = `${json}\n`;
    } else if (accept.includes('html')) {
      res.setHeader('content-type', 'text/html; charset=utf-8');

      let view: string;
      if (statusCode === 404) {
        view = errorTemplate404({
          ...errorMessage,
          http_status_code: statusCode,
          http_status_description,
          error_code,
          now_id: nowRequestId,
        });
      } else if (statusCode === 502) {
        view = errorTemplate502({
          ...errorMessage,
          http_status_code: statusCode,
          http_status_description,
          error_code,
          now_id: nowRequestId,
        });
      } else {
        view = errorTemplate({
          http_status_code: statusCode,
          http_status_description,
          now_id: nowRequestId,
        });
      }
      body = errorTemplateBase({
        http_status_code: statusCode,
        http_status_description,
        view,
      });
    } else {
      res.setHeader('content-type', 'text/plain; charset=utf-8');
      body = `${errorMessage.title}\n\n${error_code}\n`;
    }
    res.end(body);
  }

  async sendRedirect(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    nowRequestId: string,
    location: string,
    statusCode: number = 302
  ): Promise<void> {
    this.output.debug(`Redirect ${statusCode}: ${location}`);

    res.statusCode = statusCode;
    this.setResponseHeaders(res, nowRequestId, { location });

    let body: string;
    const { accept = 'text/plain' } = req.headers;
    if (accept.includes('json')) {
      res.setHeader('content-type', 'application/json');
      const json = JSON.stringify({
        redirect: location,
        status: String(statusCode),
      });
      body = `${json}\n`;
    } else if (accept.includes('html')) {
      res.setHeader('content-type', 'text/html');
      body = redirectTemplate({ location, statusCode });
    } else {
      res.setHeader('content-type', 'text/plain');
      body = `Redirecting to ${location} (${statusCode})\n`;
    }
    res.end(body);
  }

  getRequestIp(req: http.IncomingMessage): string {
    // TODO: respect the `x-forwarded-for` headers
    return req.connection.remoteAddress || '127.0.0.1';
  }

  /**
   * Sets the response `headers` including the Now headers to `res`.
   */
  setResponseHeaders(
    res: http.ServerResponse,
    nowRequestId: string,
    headers: http.OutgoingHttpHeaders = {}
  ): void {
    const allHeaders = {
      'cache-control': 'public, max-age=0, must-revalidate',
      ...headers,
      server: 'now',
      'x-now-trace': 'dev1',
      'x-now-id': nowRequestId,
      'x-now-cache': 'MISS',
    };
    for (const [name, value] of Object.entries(allHeaders)) {
      res.setHeader(name, value);
    }
  }

  /**
   * Returns the request `headers` that will be sent to the Lambda.
   */
  getNowProxyHeaders(
    req: http.IncomingMessage,
    nowRequestId: string
  ): http.IncomingHttpHeaders {
    const ip = this.getRequestIp(req);
    const { host } = req.headers;
    return {
      ...req.headers,
      Connection: 'close',
      'x-forwarded-host': host,
      'x-forwarded-proto': 'http',
      'x-forwarded-for': ip,
      'x-real-ip': ip,
      'x-now-trace': 'dev1',
      'x-now-deployment-url': host,
      'x-now-id': nowRequestId,
      'x-now-log-id': nowRequestId.split('-')[2],
      'x-zeit-co-forwarded-for': ip,
    };
  }

  async triggerBuild(
    match: BuildMatch,
    requestPath: string | null,
    req: http.IncomingMessage | null,
    previousBuildResult?: BuildResult,
    filesChanged?: string[],
    filesRemoved?: string[]
  ) {
    // If the requested asset wasn't found in the match's outputs, or
    // a hard-refresh was detected, then trigger a build
    const buildKey =
      requestPath === null ? match.src : `${match.src}-${requestPath}`;
    let buildPromise = this.inProgressBuilds.get(buildKey);
    if (buildPromise) {
      // A build for `buildKey` is already in progress, so don't trigger
      // another rebuild for this request - just wait on the existing one.
      let msg = `De-duping build "${buildKey}"`;
      if (req) msg += ` for "${req.method} ${req.url}"`;
      this.output.debug(msg);
    } else if (Date.now() - match.buildTimestamp < ms('2s')) {
      // If the built asset was created less than 2s ago, then don't trigger
      // a rebuild. The purpose of this threshold is because once an HTML page
      // is rebuilt, then the CSS/JS/etc. assets on the page are also refreshed
      // with a `no-cache` header, so this avoids *two* rebuilds for that case.
      let msg = `Skipping build for "${buildKey}" (not older than 2s)`;
      if (req) msg += ` for "${req.method} ${req.url}"`;
      this.output.debug(msg);
    } else {
      const nowConfig = await this.getNowConfig();
      if (previousBuildResult) {
        // Tear down any `output` assets from a previous build, so that they
        // are not available to be served while the rebuild is in progress.
        for (const [name] of Object.entries(previousBuildResult.output)) {
          this.output.debug(`Removing asset "${name}"`);
          delete match.buildOutput[name];
          // TODO: shut down Lambda instance
        }
      }
      let msg = `Building asset "${buildKey}"`;
      if (req) msg += ` for "${req.method} ${req.url}"`;
      this.output.debug(msg);
      buildPromise = executeBuild(
        nowConfig,
        this,
        this.files,
        match,
        requestPath,
        false,
        filesChanged,
        filesRemoved
      );
      this.inProgressBuilds.set(buildKey, buildPromise);
    }
    try {
      await buildPromise;
    } finally {
      this.output.debug(`Built asset ${buildKey}`);
      this.inProgressBuilds.delete(buildKey);
    }
  }

  /**
   * DevServer HTTP handler
   */
  devServerHandler: HttpHandler = async (
    req: http.IncomingMessage,
    res: http.ServerResponse
  ) => {
    const nowRequestId = generateRequestId(this.podId);

    if (this.stopping) {
      res.setHeader('Connection', 'close');
      await this.send404(req, res, nowRequestId);
      return;
    }

    const method = req.method || 'GET';
    this.output.debug(`${chalk.bold(method)} ${req.url}`);

    try {
      const nowConfig = await this.getNowConfig();
      await this.serveProjectAsNowV2(req, res, nowRequestId, nowConfig);
    } catch (err) {
      console.error(err);
      this.output.debug(err.stack);

      if (!res.finished) {
        res.statusCode = 500;
        res.end(err.message);
      }
    }
  };

  /**
   * Serve project directory as a Now v2 deployment.
   */
  serveProjectAsNowV2 = async (
    req: http.IncomingMessage,
    res: http.ServerResponse,
    nowRequestId: string,
    nowConfig: NowConfig,
    routes: RouteConfig[] | undefined = nowConfig.routes,
    callLevel: number = 0
  ) => {
    // If there is a double-slash present in the URL,
    // then perform a redirect to make it "clean".
    const parsed = url.parse(req.url || '/');
    if (typeof parsed.pathname === 'string' && parsed.pathname.includes('//')) {
      let location = parsed.pathname.replace(/\/+/g, '/');
      if (parsed.search) {
        location += parsed.search;
      }

      // Only `GET` requests are redirected.
      // Other methods are normalized without redirecting.
      if (req.method === 'GET') {
        await this.sendRedirect(req, res, nowRequestId, location, 301);
        return;
      }

      this.output.debug(`Rewriting URL from "${req.url}" to "${location}"`);
      req.url = location;
    }

    await this.updateBuildMatches(nowConfig);

    if (this.blockingBuildsPromise) {
      this.output.debug(
        'Waiting for builds to complete before handling request'
      );
      await this.blockingBuildsPromise;
    }

    const { dest, status, headers, uri_args } = await devRouter(
      req.url,
      req.method,
      routes,
      this
    );

    // Set any headers defined in the matched `route` config
    Object.entries(headers).forEach(([name, value]) => {
      res.setHeader(name, value);
    });

    if (isURL(dest)) {
      // Mix the `routes` result dest query params into the req path
      const destParsed = url.parse(dest, true);
      delete destParsed.search;
      Object.assign(destParsed.query, uri_args);
      const destUrl = url.format(destParsed);

      this.output.debug(`ProxyPass: ${destUrl}`);
      this.setResponseHeaders(res, nowRequestId);
      return proxyPass(req, res, destUrl, this.output);
    }

    if (status) {
      res.statusCode = status;
      if ([301, 302, 303].includes(status)) {
        await this.sendRedirect(
          req,
          res,
          nowRequestId,
          res.getHeader('location') as string,
          status
        );
        return;
      }
    }

    const requestPath = dest.replace(/^\//, '');
    const match = await findBuildMatch(
      this.buildMatches,
      this.files,
      requestPath,
      this
    );

    if (!match) {
      if (
        status === 404 ||
        !this.renderDirectoryListing(req, res, requestPath, nowRequestId)
      ) {
        await this.send404(req, res, nowRequestId);
      }
      return;
    }

    const buildRequestPath = match.buildResults.has(null) ? null : requestPath;
    const buildResult = match.buildResults.get(buildRequestPath);

    if (
      buildResult &&
      Array.isArray(buildResult.routes) &&
      buildResult.routes.length > 0
    ) {
      const origUrl = url.parse(req.url || '/', true);
      delete origUrl.search;
      origUrl.pathname = dest;
      Object.assign(origUrl.query, uri_args);
      const newUrl = url.format(origUrl);
      this.output.debug(
        `Checking build result's ${buildResult.routes.length} \`routes\` to match ${newUrl}`
      );
      const matchedRoute = await devRouter(
        newUrl,
        req.method,
        buildResult.routes,
        this
      );
      if (matchedRoute.found && callLevel === 0) {
        this.output.debug(
          `Found matching route ${matchedRoute.dest} for ${newUrl}`
        );
        req.url = newUrl;
        await this.serveProjectAsNowV2(
          req,
          res,
          nowRequestId,
          nowConfig,
          buildResult.routes,
          callLevel + 1
        );
        return;
      }
    }

    let foundAsset = findAsset(match, requestPath);
    if ((!foundAsset || this.shouldRebuild(req)) && callLevel === 0) {
      await this.triggerBuild(match, buildRequestPath, req);

      // Since the `asset` was re-built, resolve it again to get the new asset
      foundAsset = findAsset(match, requestPath);
    }

    if (!foundAsset) {
      await this.send404(req, res, nowRequestId);
      return;
    }

    const { asset, assetKey } = foundAsset;
    this.output.debug(`Serving asset: [${asset.type}] ${assetKey}`);

    /* eslint-disable no-case-declarations */
    switch (asset.type) {
      case 'FileFsRef':
        this.setResponseHeaders(res, nowRequestId);
        req.url = `/${basename(asset.fsPath)}`;
        return serveStaticFile(req, res, dirname(asset.fsPath), {
          headers: [
            {
              source: '**/*',
              headers: [
                {
                  key: 'Content-Type',
                  value: getMimeType(assetKey),
                },
              ],
            },
          ],
        });

      case 'FileBlob':
        const headers: http.OutgoingHttpHeaders = {
          'Content-Length': asset.data.length,
          'Content-Type': getMimeType(assetKey),
        };
        this.setResponseHeaders(res, nowRequestId, headers);
        res.end(asset.data);
        return;

      case 'Lambda':
        if (!asset.fn) {
          // This is mostly to appease TypeScript since `fn` is an optional prop,
          // but this shouldn't really ever happen since we run the builds before
          // responding to HTTP requests.
          await this.sendError(
            req,
            res,
            nowRequestId,
            'INTERNAL_LAMBDA_NOT_FOUND'
          );
          return;
        }

        // Mix the `routes` result dest query params into the req path
        const parsed = url.parse(req.url || '/', true);
        Object.assign(parsed.query, uri_args);
        const path = url.format({
          pathname: parsed.pathname,
          query: parsed.query,
        });

        const body = await rawBody(req);
        const payload: InvokePayload = {
          method: req.method || 'GET',
          host: req.headers.host,
          path,
          headers: this.getNowProxyHeaders(req, nowRequestId),
          encoding: 'base64',
          body: body.toString('base64'),
        };

        this.output.debug(`Invoking lambda: "${assetKey}" with ${path}`);

        let result: InvokeResult;
        try {
          result = await asset.fn<InvokeResult>({
            Action: 'Invoke',
            body: JSON.stringify(payload),
          });
        } catch (err) {
          console.error(err);
          await this.sendError(
            req,
            res,
            nowRequestId,
            'NO_STATUS_CODE_FROM_LAMBDA',
            502
          );
          return;
        }

        if (!status) {
          res.statusCode = result.statusCode;
        }
        this.setResponseHeaders(res, nowRequestId, result.headers);

        let resBody: Buffer | string | undefined;
        if (result.encoding === 'base64' && typeof result.body === 'string') {
          resBody = Buffer.from(result.body, 'base64');
        } else {
          resBody = result.body;
        }
        return res.end(resBody);

      default:
        // This shouldn't really ever happen...
        await this.sendError(req, res, nowRequestId, 'UNKNOWN_ASSET_TYPE');
    }
  };

  renderDirectoryListing(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    requestPath: string,
    nowRequestId: string
  ): boolean {
    let prefix = requestPath;
    if (prefix.length > 0 && !prefix.endsWith('/')) {
      prefix += '/';
    }

    const dirs: Set<string> = new Set();
    const files = Array.from(this.buildMatches.keys())
      .filter(p => {
        const base = basename(p);
        if (
          base === 'now.json' ||
          base === '.nowignore' ||
          !p.startsWith(prefix)
        ) {
          return false;
        }
        const rel = relative(prefix, p);
        if (rel.includes('/')) {
          const dir = rel.split('/')[0];
          if (dirs.has(dir)) {
            return false;
          }
          dirs.add(dir);
        }
        return true;
      })
      .map(p => {
        let base = basename(p);
        let ext = '';
        let type = 'file';
        let href: string;

        const rel = relative(prefix, p);
        if (rel.includes('/')) {
          // Directory
          type = 'folder';
          base = rel.split('/')[0];
          href = `/${prefix}${base}/`;
        } else {
          // File / Lambda
          ext = extname(p).substring(1);
          href = `/${prefix}${base}`;
        }
        return {
          type,
          relative: href,
          ext,
          title: href,
          base,
        };
      });

    if (files.length === 0) {
      return false;
    }

    const directory = `/${prefix}`;
    const paths = [
      {
        name: directory,
        url: requestPath,
      },
    ];
    const directoryHtml = directoryTemplate({
      files,
      paths,
      directory,
    });
    this.setResponseHeaders(res, nowRequestId);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader(
      'Content-Length',
      String(Buffer.byteLength(directoryHtml, 'utf8'))
    );
    res.end(directoryHtml);
    return true;
  }

  /**
   * Serve project directory as a static deployment.
   */
  serveProjectAsStatic = async (
    req: http.IncomingMessage,
    res: http.ServerResponse,
    nowRequestId: string
  ) => {
    const filePath = req.url ? req.url.replace(/^\//, '') : '';

    if (filePath && typeof this.files[filePath] === 'undefined') {
      await this.send404(req, res, nowRequestId);
      return;
    }

    this.setResponseHeaders(res, nowRequestId);
    return serveStaticFile(req, res, this.cwd, { cleanUrls: true });
  };

  async hasFilesystem(dest: string): Promise<boolean> {
    const requestPath = dest.replace(/^\//, '');
    if (
      await findBuildMatch(
        this.buildMatches,
        this.files,
        requestPath,
        this,
        true
      )
    ) {
      return true;
    }
    return false;
  }
}

/**
 * Mimic nginx's `proxy_pass` for routes using a URL as `dest`.
 */
function proxyPass(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  dest: string,
  output: Output
): void {
  const proxy = httpProxy.createProxyServer({
    changeOrigin: true,
    ws: true,
    xfwd: true,
    ignorePath: true,
    target: dest,
  });

  proxy.on('error', (error: NodeJS.ErrnoException) => {
    // If the client hangs up a socket, we do not
    // want to do anything, as the client just expects
    // the connection to be closed.
    if (error.code === 'ECONNRESET') {
      res.end();
      return;
    }

    output.error(`Failed to complete request to ${req.url}: ${error}`);
  });

  return proxy.web(req, res);
}

/**
 * Handle requests for static files with serve-handler.
 */
function serveStaticFile(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  cwd: string,
  opts?: object
) {
  return serveHandler(req, res, {
    public: cwd,
    cleanUrls: false,
    etag: true,
    ...opts,
  });
}

function close(server: http.Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((err?: Error) => {
      if (err) {
        reject(err);
      } else {
        resolve();
      }
    });
  });
}

/**
 * Generates a (fake) Now tracing ID for an HTTP request.
 *
 * Example: dev1:q4wlg-1562364135397-7a873ac99c8e
 */
function generateRequestId(podId: string): string {
  return `dev1:${[podId, Date.now(), randomBytes(6).toString('hex')].join(
    '-'
  )}`;
}

function hasOwnProperty(obj: any, prop: string) {
  return Object.prototype.hasOwnProperty.call(obj, prop);
}

async function findBuildMatch(
  matches: Map<string, BuildMatch>,
  files: BuilderInputs,
  requestPath: string,
  devServer: DevServer,
  isFilesystem?: boolean
): Promise<BuildMatch | null> {
  for (const match of matches.values()) {
    if (await shouldServe(match, files, requestPath, devServer, isFilesystem)) {
      return match;
    }
  }
  return null;
}

async function shouldServe(
  match: BuildMatch,
  files: BuilderInputs,
  requestPath: string,
  devServer: DevServer,
  isFilesystem?: boolean
): Promise<boolean> {
  const {
    src: entrypoint,
    config,
    builderWithPkg: { builder },
  } = match;
  if (typeof builder.shouldServe === 'function') {
    const shouldServe = await builder.shouldServe({
      entrypoint,
      files,
      config,
      requestPath,
      workPath: devServer.cwd,
    });
    if (shouldServe) {
      return true;
    }
  } else if (findAsset(match, requestPath)) {
    // If there's no `shouldServe()` function, then look up if there's
    // a matching build asset on the `match` that has already been built.
    return true;
  } else if (
    !isFilesystem &&
    (await findMatchingRoute(match, requestPath, devServer))
  ) {
    // If there's no `shouldServe()` function and no matched asset, then look
    // up if there's a matching build route on the `match` that has already
    // been built.
    return true;
  }
  return false;
}

async function findMatchingRoute(
  match: BuildMatch,
  requestPath: string,
  devServer: DevServer
): Promise<RouteResult | void> {
  const reqUrl = `/${requestPath}`;
  for (const buildResult of match.buildResults.values()) {
    if (!Array.isArray(buildResult.routes)) continue;
    const route = await devRouter(
      reqUrl,
      undefined,
      buildResult.routes,
      devServer
    );
    if (route.found) {
      return route;
    }
  }
}

function findAsset(
  match: BuildMatch,
  requestPath: string
): { asset: BuilderOutput; assetKey: string } | void {
  if (!match.buildOutput) {
    return;
  }
  let assetKey: string = requestPath.replace(/\/$/, '');
  let asset = match.buildOutput[requestPath];

  // In the case of an index path, fall back to iterating over the
  // builder outputs and doing an "is index" check until a match is found.
  if (!asset) {
    for (const [name, a] of Object.entries(match.buildOutput)) {
      if (isIndex(name) && dirnameWithoutDot(name) === assetKey) {
        asset = a;
        assetKey = name;
        break;
      }
    }
  }

  if (asset) {
    return { asset, assetKey };
  }
}

function dirnameWithoutDot(path: string): string {
  let dir = dirname(path);
  if (dir === '.') {
    dir = '';
  }
  return dir;
}

function isIndex(path: string): boolean {
  const ext = extname(path);
  const name = basename(path, ext);
  return name === 'index';
}

function minimatches(files: string[], pattern: string): boolean {
  return files.some(file => file === pattern || minimatch(file, pattern));
}

function fileChanged(
  name: string,
  changed: Set<string>,
  removed: Set<string>
): void {
  changed.add(name);
  removed.delete(name);
}

function fileRemoved(
  name: string,
  files: BuilderInputs,
  changed: Set<string>,
  removed: Set<string>
): void {
  delete files[name];
  changed.delete(name);
  removed.add(name);
}

function needsBlockingBuild(buildMatch: BuildMatch): boolean {
  const { builder } = buildMatch.builderWithPkg;
  return typeof builder.shouldServe !== 'function';
}
