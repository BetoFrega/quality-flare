import { build } from "rolldown";
import type { Plugin } from "vite";

const ID = "virtual:test-runtime";
const RESOLVED = `\0${ID}`;

/**
 * Bundles src/checks/tests/runtime (vitest's runner and expect, without vitest) into one
 * ES module and exposes its source as the default export of `virtual:test-runtime`.
 * The Tests check hands that source to each Dynamic Worker it loads.
 */
export function testRuntime(): Plugin {
	return {
		name: "quality-flare:test-runtime",
		resolveId: (id) => (id === ID ? RESOLVED : undefined),
		async load(id) {
			if (id !== RESOLVED) return;
			const entry = new URL("../src/checks/tests/runtime/index.ts", import.meta.url).pathname;
			const result = await build({
				input: entry,
				platform: "neutral",
				write: false,
				output: { format: "esm", minify: true },
				logLevel: "silent",
			});
			return `export default ${JSON.stringify(result.output[0].code)};`;
		},
	};
}
