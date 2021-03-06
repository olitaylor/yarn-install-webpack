var MemoryFS = require("memory-fs");
var webpack = require("webpack");

var installer = require("./installer");
var utils = require("./utils");

var depFromErr = function (err) {
  if (!err) {
    return undefined;
  }

  /**
   * Supported package formats:
   * - path
   * - react-lite
   * - @cycle/core
   * - bootswatch/lumen/bootstrap.css
   * - lodash.random
   */
  var matches = /(?:(?:Cannot resolve module)|(?:Can't resolve)) '([@\w\/\.-]+)' in/.exec(
    err
  );

  if (!matches) {
    return undefined;
  }

  return matches[1];
};

function YarnInstallPlugin(options) {
  this.preCompiler = null;
  this.compiler = null;
  this.options = Object.assign(installer.defaultOptions, options);
  this.resolving = {};

  installer.checkBabel();
}

YarnInstallPlugin.prototype.apply = function (compiler) {
  this.compiler = compiler;

  var plugin = { name: "YarnInstallPlugin" };

  // Recursively install missing dependencies so primary build doesn't fail
  compiler.hooks.watchRun.tapAsync(plugin, this.preCompile.bind(this));

  // Install externals that wouldn't normally be resolved
  if (Array.isArray(compiler.options.externals)) {
    compiler.options.externals.unshift(this.resolveExternal.bind(this));
  }

  compiler.hooks.afterResolvers.tap(plugin, (compiler) => {
    // Install loaders on demand
    compiler.resolverFactory.hooks.resolver.tap(
      "loader",
      plugin,
      (resolver) => {
        resolver.hooks.module.tapAsync(
          "YarnInstallPlugin",
          this.resolveLoader.bind(this)
        );
      }
    );

    // Install project dependencies on demand
    compiler.resolverFactory.hooks.resolver.tap(
      "normal",
      plugin,
      (resolver) => {
        resolver.hooks.module.tapAsync(
          "YarnInstallPlugin",
          this.resolveModule.bind(this)
        );
      }
    );
  });
};

YarnInstallPlugin.prototype.install = function (result) {
  if (!result) {
    return;
  }

  var dep = installer.check(result.request);

  if (dep) {
    var dev = this.options.dev;

    if (typeof this.options.dev === "function") {
      dev = !!this.options.dev(result.request, result.path);
    }

    installer.install(dep, Object.assign({}, this.options, { dev: dev }));
  }
};

YarnInstallPlugin.prototype.preCompile = function (compilation, next) {
  if (!this.preCompiler) {
    var options = this.compiler.options;
    var config = Object.assign(
      // Start with new config object
      {},
      // Inherit the current config
      options,
      {
        // Ensure fresh cache
        cache: {},
        // Register plugin to install missing deps
        plugins: [new YarnInstallPlugin(this.options)],
      }
    );

    this.preCompiler = webpack(config);
    this.preCompiler.outputFileSystem = new MemoryFS();
  }

  this.preCompiler.run(next);
};

YarnInstallPlugin.prototype.resolveExternal = function (
  context,
  request,
  callback
) {
  // Only install direct dependencies, not sub-dependencies
  if (context.match("node_modules")) {
    return callback();
  }

  // Ignore !!bundle?lazy!./something
  if (request.match(/(\?|\!)/)) {
    return callback();
  }

  var result = {
    context: {},
    path: context,
    request: request,
  };

  this.resolve(
    "normal",
    result,
    function (err, filepath) {
      if (err) {
        this.install(Object.assign({}, result, { request: depFromErr(err) }));
      }

      callback();
    }.bind(this)
  );
};

YarnInstallPlugin.prototype.resolve = function (resolver, result, callback) {
  var version = require("webpack/package.json").version;
  var major = version.split(".").shift();

  if (major === "4") {
    return this.compiler.resolverFactory
      .get(resolver)
      .resolve(result.context || {}, result.path, result.request, {}, callback);
  }

  throw new Error("Unsupported Webpack version: " + version);
};

YarnInstallPlugin.prototype.resolveLoader = function (
  result,
  resolveContext,
  next
) {
  // Only install direct dependencies, not sub-dependencies
  if (result.path.match("node_modules")) {
    return next();
  }

  if (this.resolving[result.request]) {
    return next();
  }

  this.resolving[result.request] = true;

  this.resolve(
    "loader",
    result,
    function (err, filepath) {
      this.resolving[result.request] = false;

      if (err) {
        var loader = utils.normalizeLoader(result.request);
        this.install(Object.assign({}, result, { request: loader }));
      }

      return next();
    }.bind(this)
  );
};

YarnInstallPlugin.prototype.resolveModule = function (
  result,
  resolveContext,
  next
) {
  // Only install direct dependencies, not sub-dependencies
  if (result.path.match("node_modules")) {
    return next();
  }

  if (this.resolving[result.request]) {
    return next();
  }

  this.resolving[result.request] = true;

  this.resolve(
    "normal",
    result,
    function (err, filepath) {
      this.resolving[result.request] = false;

      if (err) {
        this.install(Object.assign({}, result, { request: depFromErr(err) }));
      }

      return next();
    }.bind(this)
  );
};

module.exports = YarnInstallPlugin;
