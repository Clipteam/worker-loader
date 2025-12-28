import path from "path";

import { getOptions } from "loader-utils";
import { validate } from "schema-utils";

import schema from "./options.json";
import supportWebpack5 from "./supportWebpack5";
import supportWebpack4 from "./supportWebpack4";
import {
  getDefaultFilename,
  getDefaultChunkFilename,
  getExternalsType,
} from "./utils";

// Cache for webpack plugins resolved from the compiler's webpack instance
const webpackPluginsCache = new WeakMap();

/**
 * Get webpack plugins from the compiler's webpack instance.
 * This ensures we use the same webpack version as the parent compiler,
 * avoiding "compilation argument must be an instance of Compilation" errors
 * when multiple webpack versions are installed.
 */
function getWebpackPlugins(compiler) {
  if (webpackPluginsCache.has(compiler)) {
    return webpackPluginsCache.get(compiler);
  }

  const { webpack } = compiler;
  const isWebpack5 =
    webpack && webpack.version && webpack.version.startsWith("5.");

  let plugins;

  if (isWebpack5) {
    // Webpack 5: use compiler.webpack to access modules
    plugins = {
      NodeTargetPlugin: webpack.node.NodeTargetPlugin,
      EntryPlugin: webpack.EntryPlugin,
      WebWorkerTemplatePlugin: webpack.webworker.WebWorkerTemplatePlugin,
      ExternalsPlugin: webpack.ExternalsPlugin,
      FetchCompileWasmPlugin: webpack.web.FetchCompileWasmPlugin,
      FetchCompileAsyncWasmPlugin: webpack.web.FetchCompileAsyncWasmPlugin,
      isWebpack5: true,
    };
  } else {
    // Webpack 4: require from webpack (fallback for older versions without compiler.webpack)
    // eslint-disable-next-line global-require, import/no-unresolved
    plugins = {
      // eslint-disable-next-line global-require, import/no-unresolved
      NodeTargetPlugin: require("webpack/lib/node/NodeTargetPlugin"),
      // eslint-disable-next-line global-require, import/no-unresolved
      SingleEntryPlugin: require("webpack/lib/SingleEntryPlugin"),
      // eslint-disable-next-line global-require, import/no-unresolved
      WebWorkerTemplatePlugin: require("webpack/lib/webworker/WebWorkerTemplatePlugin"),
      // eslint-disable-next-line global-require, import/no-unresolved
      ExternalsPlugin: require("webpack/lib/ExternalsPlugin"),
      // eslint-disable-next-line global-require, import/no-unresolved, import/extensions
      FetchCompileWasmPlugin: require("webpack/lib/web/FetchCompileWasmTemplatePlugin"),
      FetchCompileAsyncWasmPlugin: null,
      isWebpack5: false,
    };
  }

  webpackPluginsCache.set(compiler, plugins);
  return plugins;
}

export default function loader() {}

export function pitch(request) {
  this.cacheable(false);

  const options = getOptions(this);

  validate(schema, options, {
    name: "Worker Loader",
    baseDataPath: "options",
  });

  // Get webpack plugins from the compiler's webpack instance
  // This ensures compatibility when multiple webpack versions are installed
  const plugins = getWebpackPlugins(this._compiler);
  const {
    NodeTargetPlugin,
    EntryPlugin,
    SingleEntryPlugin,
    WebWorkerTemplatePlugin,
    ExternalsPlugin,
    FetchCompileWasmPlugin,
    FetchCompileAsyncWasmPlugin,
    isWebpack5,
  } = plugins;

  const workerContext = {};
  const compilerOptions = this._compiler.options || {};
  const filename = options.filename
    ? options.filename
    : getDefaultFilename(compilerOptions.output.filename);
  const chunkFilename = options.chunkFilename
    ? options.chunkFilename
    : getDefaultChunkFilename(compilerOptions.output.chunkFilename);
  const publicPath = options.publicPath
    ? options.publicPath
    : compilerOptions.output.publicPath;

  workerContext.options = {
    filename,
    chunkFilename,
    publicPath,
    globalObject: "self",
  };

  workerContext.compiler = this._compilation.createChildCompiler(
    `worker-loader ${request}`,
    workerContext.options
  );

  new WebWorkerTemplatePlugin().apply(workerContext.compiler);

  if (this.target !== "webworker" && this.target !== "web") {
    new NodeTargetPlugin().apply(workerContext.compiler);
  }

  if (FetchCompileWasmPlugin) {
    new FetchCompileWasmPlugin({
      mangleImports: compilerOptions.optimization.mangleWasmImports,
    }).apply(workerContext.compiler);
  }

  if (FetchCompileAsyncWasmPlugin) {
    new FetchCompileAsyncWasmPlugin().apply(workerContext.compiler);
  }

  if (compilerOptions.externals) {
    new ExternalsPlugin(
      getExternalsType(compilerOptions),
      compilerOptions.externals
    ).apply(workerContext.compiler);
  }

  // Use EntryPlugin for webpack 5, SingleEntryPlugin for webpack 4
  const EntryPluginClass = isWebpack5 ? EntryPlugin : SingleEntryPlugin;
  new EntryPluginClass(
    this.context,
    `!!${request}`,
    path.parse(this.resourcePath).name
  ).apply(workerContext.compiler);

  workerContext.request = request;

  const cb = this.async();

  if (
    workerContext.compiler.cache &&
    typeof workerContext.compiler.cache.get === "function"
  ) {
    supportWebpack5(this, workerContext, options, cb);
  } else {
    supportWebpack4(this, workerContext, options, cb);
  }
}
