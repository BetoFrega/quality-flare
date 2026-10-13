import { describe, expect, it } from "vitest";
import { readVitestConfig } from "../../../src/checks/tests/vitest-config.ts";

const reader = (files: Record<string, string>) => async (path: string) => files[path];

// Trimmed from Tudo Macaé: a unit config that merges into the ordinary one, which merges a shared one.
const MACAE = {
	"vitest.unit.config.mts": `import { mergeConfig } from "vitest/config";
import ordinary from "./vitest.config.mts";

export default mergeConfig(ordinary, {
  test: {
    exclude: ["**/*.integration.test.{ts,tsx}"],
    // Process suites: "test: {" in a comment is not a block.
    maxWorkers: 4,
  },
});`,
	"vitest.config.mts": `import { configDefaults, defineConfig, mergeConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import path from 'path'
import { sharedTestConfig } from './vitest.shared.mts'

export default mergeConfig(sharedTestConfig, defineConfig({
  plugins: [react()],
  test: {
    environment: 'node',
    include: [
      'src/**/*.test.{ts,tsx}',
      // The harness modules in \`bin/\`, with a comma, in a comment.
      'bin/**/*.test.ts',
    ],
    exclude: [
      ...configDefaults.exclude,
      "**/*.runtime.test.ts",
    ],
    globals: true,
    setupFiles: ['./vitest.setup.ts'],
    coverage: { include: ['src/**'] },
  },
  resolve: { alias: { '@': path.resolve(__dirname, './src') } },
}))`,
	"vitest.shared.mts": `import { defineConfig } from "vitest/config";
export const sharedTestConfig = defineConfig({
  test: {
    testTimeout: 20_000,
  },
});`,
};

describe("readVitestConfig", () => {
	it("reads the unit config through mergeConfig into the configs it imports", async () => {
		expect(await readVitestConfig(reader(MACAE))).toEqual({
			path: "vitest.unit.config.mts",
			config: {
				testTimeout: 20000,
				include: ["src/**/*.test.{ts,tsx}", "bin/**/*.test.ts"],
				exclude: ["**/node_modules/**", "**/.git/**", "**/*.runtime.test.ts", "**/*.integration.test.{ts,tsx}"],
				globals: true,
				setupFiles: ["./vitest.setup.ts"],
				environment: "node",
			},
		});
	});

	it("falls back to vitest.config, and leaves out values computed at run time", async () => {
		const files = { "vitest.config.ts": `export default { test: { include: process.env.CI ? ["a"] : ["b"], "globals": false, clearMocks: false, restoreMocks: true, mockReset: process.env.CI } }` };
		expect(await readVitestConfig(reader(files))).toEqual({ path: "vitest.config.ts", config: { globals: false, clearMocks: false, restoreMocks: true } });
	});

	it("is empty without a vitest config", async () => {
		expect(await readVitestConfig(reader({}))).toEqual({ config: {} });
	});
});
