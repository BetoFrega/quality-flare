import { defineConfig } from "vitest/config";
import { testRuntime } from "./build/test-runtime.ts";

// Kept separate from vite.config.ts so tests run in plain Node, without the Workers runtime.
export default defineConfig({
	plugins: [testRuntime()],
	test: { include: ["test/**/*.test.ts"] },
});
