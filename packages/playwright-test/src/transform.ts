/**
 * Copyright (c) Microsoft Corporation.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import * as crypto from 'crypto';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import * as pirates from 'pirates';
import * as sourceMapSupport from 'source-map-support';
import * as url from 'url';
import type { Location } from './types';
import { tsConfigLoader, TsConfigLoaderResult } from './third_party/tsconfig-loader';

const version = 6;
const cacheDir = process.env.PWTEST_CACHE_DIR || path.join(os.tmpdir(), 'playwright-transform-cache');
const sourceMaps: Map<string, string> = new Map();

type ParsedTsConfigData = {
  absoluteBaseUrl: string,
  singlePath: { [key: string]: string },
  hash: string,
  alias: { [key: string]: string | ((s: string[]) => string) },
};
const cachedTSConfigs = new Map<string, ParsedTsConfigData | undefined>();

const kStackTraceLimit = 15;
Error.stackTraceLimit = kStackTraceLimit;

sourceMapSupport.install({
  environment: 'node',
  handleUncaughtExceptions: false,
  retrieveSourceMap(source) {
    if (!sourceMaps.has(source))
      return null;
    const sourceMapPath = sourceMaps.get(source)!;
    if (!fs.existsSync(sourceMapPath))
      return null;
    return {
      map: JSON.parse(fs.readFileSync(sourceMapPath, 'utf-8')),
      url: source
    };
  }
});

function calculateCachePath(tsconfigData: ParsedTsConfigData | undefined, content: string, filePath: string): string {
  const hash = crypto.createHash('sha1')
      .update(tsconfigData?.hash || '')
      .update(process.env.PW_EXPERIMENTAL_TS_ESM ? 'esm' : 'no_esm')
      .update(content)
      .update(filePath)
      .update(String(version))
      .digest('hex');
  const fileName = path.basename(filePath, path.extname(filePath)).replace(/\W/g, '') + '_' + hash;
  return path.join(cacheDir, hash[0] + hash[1], fileName);
}

function validateTsConfig(tsconfig: TsConfigLoaderResult): ParsedTsConfigData | undefined {
  if (!tsconfig.tsConfigPath || !tsconfig.paths || !tsconfig.baseUrl)
    return;

  const paths = tsconfig.paths;
  // Path that only contains "*", ".", "/" and "\" is too ambiguous.
  const ambiguousPath = Object.keys(paths).find(key => key.match(/^[*./\\]+$/));
  if (ambiguousPath)
    return;
  const multiplePath = Object.keys(paths).find(key => paths[key].length > 1);
  if (multiplePath)
    return;
  // Only leave a single path mapping.
  const singlePath = Object.fromEntries(Object.entries(paths).map(([key, values]) => ([key, values[0]])));
  // Make 'baseUrl' absolute, because it is relative to the tsconfig.json, not to cwd.
  const absoluteBaseUrl = path.resolve(path.dirname(tsconfig.tsConfigPath), tsconfig.baseUrl);
  const hash = JSON.stringify({ absoluteBaseUrl, singlePath });

  const alias: ParsedTsConfigData['alias'] = {};
  for (const [key, value] of Object.entries(singlePath)) {
    const regexKey = '^' + key.replace('*', '.*');
    alias[regexKey] = ([name]) => {
      let relative: string;
      if (key.endsWith('/*'))
        relative = value.substring(0, value.length - 1) + name.substring(key.length - 1);
      else
        relative = value;
      relative = relative.replace(/\//g, path.sep);
      return path.resolve(absoluteBaseUrl, relative);
    };
  }

  return {
    absoluteBaseUrl,
    singlePath,
    hash,
    alias,
  };
}

function loadAndValidateTsconfigForFile(file: string): ParsedTsConfigData | undefined {
  const cwd = path.dirname(file);
  if (!cachedTSConfigs.has(cwd)) {
    const loaded = tsConfigLoader({
      getEnv: (name: string) => process.env[name],
      cwd
    });
    cachedTSConfigs.set(cwd, validateTsConfig(loaded));
  }
  return cachedTSConfigs.get(cwd);
}

export function transformHook(code: string, filename: string, isModule = false): string {
  if (isComponentImport(filename))
    return componentStub();

  const tsconfigData = loadAndValidateTsconfigForFile(filename);
  const cachePath = calculateCachePath(tsconfigData, code, filename);
  const codePath = cachePath + '.js';
  const sourceMapPath = cachePath + '.map';
  sourceMaps.set(filename, sourceMapPath);
  if (!process.env.PW_IGNORE_COMPILE_CACHE && fs.existsSync(codePath))
    return fs.readFileSync(codePath, 'utf8');
  // We don't use any browserslist data, but babel checks it anyway.
  // Silence the annoying warning.
  process.env.BROWSERSLIST_IGNORE_OLD_DATA = 'true';
  const babel: typeof import('@babel/core') = require('@babel/core');

  const plugins = [
    [require.resolve('@babel/plugin-proposal-class-properties')],
    [require.resolve('@babel/plugin-proposal-numeric-separator')],
    [require.resolve('@babel/plugin-proposal-logical-assignment-operators')],
    [require.resolve('@babel/plugin-proposal-nullish-coalescing-operator')],
    [require.resolve('@babel/plugin-proposal-optional-chaining')],
    [require.resolve('@babel/plugin-syntax-json-strings')],
    [require.resolve('@babel/plugin-syntax-optional-catch-binding')],
    [require.resolve('@babel/plugin-syntax-async-generators')],
    [require.resolve('@babel/plugin-syntax-object-rest-spread')],
    [require.resolve('@babel/plugin-proposal-export-namespace-from')],
  ] as any;

  if (tsconfigData) {
    plugins.push([require.resolve('babel-plugin-module-resolver'), {
      root: ['./'],
      alias: tsconfigData.alias,
      // Silences warning 'Could not resovle ...' that we trigger because we resolve
      // into 'foo/bar', and not 'foo/bar.ts'.
      loglevel: 'silent',
    }]);
  }

  if (process.env.PW_COMPONENT_TESTING)
    plugins.unshift([require.resolve('@babel/plugin-transform-react-jsx')]);

  if (!isModule) {
    plugins.push([require.resolve('@babel/plugin-transform-modules-commonjs')]);
    plugins.push([require.resolve('@babel/plugin-proposal-dynamic-import')]);
  }

  const result = babel.transformFileSync(filename, {
    babelrc: false,
    configFile: false,
    assumptions: {
      // Without this, babel defines a top level function that
      // breaks playwright evaluates.
      setPublicClassFields: true,
    },
    presets: [
      [require.resolve('@babel/preset-typescript'), { onlyRemoveTypeImports: true }],
    ],
    plugins,
    sourceMaps: 'both',
  } as babel.TransformOptions)!;
  if (result.code) {
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    if (result.map)
      fs.writeFileSync(sourceMapPath, JSON.stringify(result.map), 'utf8');
    fs.writeFileSync(codePath, result.code, 'utf8');
  }
  return result.code || '';
}

export function installTransform(): () => void {
  return pirates.addHook((code: string, filename: string) => transformHook(code, filename), { exts: ['.ts', '.tsx'] });
}

export function wrapFunctionWithLocation<A extends any[], R>(func: (location: Location, ...args: A) => R): (...args: A) => R {
  return (...args) => {
    const oldPrepareStackTrace = Error.prepareStackTrace;
    Error.prepareStackTrace = (error, stackFrames) => {
      const frame: NodeJS.CallSite = sourceMapSupport.wrapCallSite(stackFrames[1]);
      const fileName = frame.getFileName();
      // Node error stacks for modules use file:// urls instead of paths.
      const file = (fileName && fileName.startsWith('file://')) ? url.fileURLToPath(fileName) : fileName;
      return {
        file,
        line: frame.getLineNumber(),
        column: frame.getColumnNumber(),
      };
    };
    Error.stackTraceLimit = 2;
    const obj: { stack: Location } = {} as any;
    Error.captureStackTrace(obj);
    const location = obj.stack;
    Error.stackTraceLimit = kStackTraceLimit;
    Error.prepareStackTrace = oldPrepareStackTrace;
    return func(location, ...args);
  };
}

// Experimental components support for internal testing.
function isComponentImport(filename: string): boolean {
  if (!process.env.PW_COMPONENT_TESTING)
    return false;
  if (filename.endsWith('.tsx') && !filename.endsWith('spec.tsx') && !filename.endsWith('test.tsx'))
    return true;
  if (filename.endsWith('.jsx') && !filename.endsWith('spec.jsx') && !filename.endsWith('test.jsx'))
    return true;
  return false;
}

function componentStub(): string {
  return `module.exports = new Proxy({}, {
    get: (obj, prop) => prop
  });`;
}
