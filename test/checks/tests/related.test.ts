import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

// qf-related runs git in a container; the Workers runtime (quality-flare's own Tests check) has neither.
const inWorkers = globalThis.navigator?.userAgent === "Cloudflare-Workers";
const SCRIPT = new URL("../../../containers/tests/qf-related.mjs", import.meta.url).pathname;

describe.skipIf(inWorkers)("qf-related", () => {
	let repo: string;
	afterEach(() => rmSync(repo, { recursive: true, force: true }));

	const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: repo, encoding: "utf8" });
	function write(files: Record<string, unknown>) {
		for (const [path, content] of Object.entries(files)) {
			mkdirSync(dirname(join(repo, path)), { recursive: true });
			writeFileSync(join(repo, path), typeof content === "string" ? content : JSON.stringify(content, null, 2));
		}
	}
	function commit(files: Record<string, unknown>) {
		write(files);
		git("add", "-A");
		git("commit", "-q", "-m", "c");
	}
	const related = (...config: string[]) =>
		execFileSync("node", [SCRIPT, "base", ...config], { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
			.split("\n")
			.filter(Boolean)
			.sort();

	const lock = (packages: Record<string, unknown>) => ({ lockfileVersion: 3, packages: { "": { name: "app" }, ...packages } });
	const BASE = {
		"package.json": { name: "app", workspaces: ["packages/*"], dependencies: { zod: "^4.0.0", react: "^19.0.0" }, devDependencies: { vitest: "^5.0.0" } },
		"package-lock.json": lock({
			"node_modules/zod": { version: "4.0.0" },
			"node_modules/react": { version: "19.0.0", dependencies: { "loose-envify": "^1.0.0" } },
			"node_modules/loose-envify": { version: "1.0.0" },
			"node_modules/vitest": { version: "5.0.0", dependencies: { vite: "^8" }, peerDependencies: { jsdom: "*" }, peerDependenciesMeta: { jsdom: { optional: true } } },
			"node_modules/vite": { version: "8.0.0", peerDependencies: { "@types/node": "*" } },
			"node_modules/ui": { resolved: "packages/ui", link: true },
		}),
		"vitest.config.mts": 'import { defineConfig } from "vitest/config";\nimport { shared } from "./vitest.shared";\nexport default defineConfig(shared);\n',
		"vitest.shared.mts": "export const shared = {};\n",
		"vitest.unit.config.mts": 'import base from "./vitest.config.mts";\nexport default base;\n',
		"src/schema.ts": 'import { z } from "zod";\nexport const s = z.string();\n',
		"src/schema.test.ts": 'import { s } from "./schema";\n',
		"src/view.tsx": "import React from 'react';\n",
		"src/plain.ts": "export const plain = 1;\n",
		"bin/scripts.test.ts": 'import manifest from "../package.json";\n',
		// Split, or vitest would read it as this file's own environment.
		"src/dom.test.ts": `// @vitest-${"environment"} jsdom\n`,
		"packages/ui/package.json": { name: "ui", main: "index.ts" },
		"packages/ui/index.ts": "export const ui = 1;\n",
		"packages/ui/vitest.config.ts": "export default {};\n",
	};

	function setup(change: Record<string, unknown>) {
		repo = mkdtempSync(join(tmpdir(), "qf-related-"));
		git("init", "-q");
		commit(BASE);
		git("branch", "base");
		commit(change);
	}

	it("lists the PR's files when no package changed", () => {
		setup({ "src/plain.ts": "export const plain = 2;\n" });
		expect(related()).toEqual(["src/plain.ts"]);
	});

	it("turns a dependency bump into the files that import it", () => {
		setup({
			"package.json": { ...BASE["package.json"], dependencies: { zod: "^4.1.0", react: "^19.0.0" } },
			"package-lock.json": lock({ ...BASE["package-lock.json"].packages, "node_modules/zod": { version: "4.1.0" } }),
		});
		expect(related()).toEqual(["src/schema.ts"]);
	});

	it("reaches the packages that depend on a transitive package that changed", () => {
		setup({ "package-lock.json": lock({ ...BASE["package-lock.json"].packages, "node_modules/loose-envify": { version: "1.1.0" } }) });
		expect(related()).toEqual(["src/view.tsx"]);
	});

	it("counts a vitest environment comment as a use", () => {
		setup({ "package-lock.json": lock({ ...BASE["package-lock.json"].packages, "node_modules/jsdom": { version: "1.0.0" } }) });
		expect(related()).toEqual(["src/dom.test.ts"]);
	});

	it("lists nothing for a package no file names", () => {
		setup({ "package-lock.json": lock({ ...BASE["package-lock.json"].packages, "node_modules/left-pad": { version: "1.0.0" } }) });
		expect(related()).toEqual([]);
	});

	it("ignores type packages, even ones vitest depends on", () => {
		setup({ "package-lock.json": lock({ ...BASE["package-lock.json"].packages, "node_modules/@types/node": { version: "26.0.0" } }) });
		expect(related()).toEqual([]);
	});

	it("runs everything when vitest or what it depends on changed", () => {
		setup({ "package-lock.json": lock({ ...BASE["package-lock.json"].packages, "node_modules/vite": { version: "8.1.0" } }) });
		expect(related()).toEqual(["all"]);
	});

	it("runs everything when the vitest config, or a file it imports, names the package", () => {
		setup({
			"vitest.shared.mts": 'import react from "react";\n',
			"package-lock.json": lock({ ...BASE["package-lock.json"].packages, "node_modules/react": { version: "19.1.0", dependencies: { "loose-envify": "^1.0.0" } } }),
		});
		expect(related()).toEqual(["all"]);
		expect(related("vitest.unit.config.mts")).toEqual(["all"]);
	});

	it("leaves out vitest configs the run doesn't use", () => {
		setup({
			"vitest.mutation.config.mts": 'import react from "react";\n',
			"package-lock.json": lock({ ...BASE["package-lock.json"].packages, "node_modules/react": { version: "19.1.0", dependencies: { "loose-envify": "^1.0.0" } } }),
		});
		expect(related("vitest.unit.config.mts")).toEqual(["src/view.tsx", "vitest.mutation.config.mts"]);
	});

	it("turns a change to the scripts into the files that name package.json", () => {
		setup({ "package.json": { ...BASE["package.json"], scripts: { test: "vitest" } } });
		expect(related()).toEqual(["bin/scripts.test.ts"]);
	});

	it("runs everything when the root package.json changed beyond its dependencies and scripts", () => {
		setup({ "package.json": { ...BASE["package.json"], overrides: { zod: "4.0.1" } } });
		expect(related()).toEqual(["all"]);
	});

	it("turns any other change to a workspace's package.json into its files, without vitest's rerun triggers", () => {
		setup({ "packages/ui/package.json": { name: "ui", main: "index.ts", exports: "./index.ts" } });
		expect(related()).toEqual(["bin/scripts.test.ts", "packages/ui/index.ts"]);
	});

	it("runs everything for a lockfile it doesn't read", () => {
		setup({ "pnpm-lock.yaml": "lockfileVersion: '9.0'\n" });
		expect(related()).toEqual(["all"]);
	});
});
