import { defineConfig } from "vitest/config";
import { docs } from "./build/docs.ts";
import { testRuntime } from "./build/test-runtime.ts";

// Kept separate from vite.config.ts so tests run in plain Node, without the Workers runtime.
export default defineConfig({
	plugins: [testRuntime(), docs()],
	test: { include: ["test/**/*.test.ts"] },
	// The Worker imports cloudflare:workers (src/shard-tail.ts), which only the Workers runtime has.
	resolve: { alias: { "cloudflare:workers": new URL("./test/cloudflare-workers.ts", import.meta.url).pathname } },
});
