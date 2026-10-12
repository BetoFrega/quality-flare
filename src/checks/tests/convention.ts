/**
 * Which files of a repository the Tests check runs, and which it may load. The goal is
 * zero configuration: any `*.test.*` or `*.spec.*` file is a test file, as in vitest.
 */

/** Test files: `*.test.ts`, `*.spec.mjs`, and so on. */
const TEST_FILE = /\.(test|spec)\.(ts|mts|tsx|js|mjs|jsx)$/;

/** Files the Dynamic Worker can load as modules. */
export const MODULE_FILE = /\.(ts|mts|tsx|js|mjs|cjs|jsx|json)$/;

/** Directories never scanned: dependencies, build output and tool caches. */
const SKIPPED_DIR = /(^|\/)(node_modules|dist|build|coverage|\.[^/]+)\//;

export const isTestFile = (path: string) => TEST_FILE.test(path) && !SKIPPED_DIR.test(path);

/** Other repository files tests may read with node:fs: text, at most 1 MB each. */
export const isAsset = (path: string, size: number) =>
	size <= 1024 * 1024 && !/(^|\/)(node_modules|\.git)\//.test(path) && !/\.(png|jpe?g|gif|webp|avif|ico|woff2?|ttf|otf|eot|pdf|zip|gz|tgz|mp[34]|webm|wasm)$/i.test(path);

export const isLoadable = (path: string) => MODULE_FILE.test(path) && !SKIPPED_DIR.test(path) && !path.endsWith(".d.ts");

/** Playwright end-to-end specs: they also use `*.spec.ts`, but drive a browser. */
export const isPlaywrightSpec = (source: string) => /(?:from\s*|require\(\s*)["']@playwright\/test["']/.test(source);
