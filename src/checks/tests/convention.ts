/**
 * Which files of a repository the Tests check runs, and which it may load. The goal is
 * zero configuration: any `*.test.*` or `*.spec.*` file is a test file, as in vitest.
 */

/** Test files: `*.test.ts`, `*.spec.mjs`, and so on. */
const TEST_FILE = /\.(test|spec)\.(ts|mts|js|mjs)$/;

/** Files the Dynamic Worker can load as modules. */
export const MODULE_FILE = /\.(ts|mts|js|mjs|json)$/;

/** Directories never scanned: dependencies, build output and tool caches. */
const SKIPPED_DIR = /(^|\/)(node_modules|dist|build|coverage|\.[^/]+)\//;

export const isTestFile = (path: string) => TEST_FILE.test(path) && !SKIPPED_DIR.test(path);

export const isLoadable = (path: string) => MODULE_FILE.test(path) && !SKIPPED_DIR.test(path) && !path.endsWith(".d.ts");
