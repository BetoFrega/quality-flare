import { describe, expect, it } from "vitest";
import { parseYaml, readLockfile } from "../../../src/checks/tests/lockfile.ts";

const PNPM = `lockfileVersion: '9.0'

importers:

  .:
    devDependencies:
      sucrase:
        specifier: ^3.35.1
        version: 3.35.1
      vite:
        specifier: ^8.3.0
        version: 8.3.4(@types/node@22.0.0)

  packages/web:
    dependencies:
      sucrase:
        specifier: 3.0.0
        version: 3.0.0
      shared:
        specifier: workspace:*
        version: link:../shared

packages:

  sucrase@3.35.1:
    resolution: {integrity: sha512-abc}
    engines: {node: '>=16 || 14 >=14.17'}

snapshots:

  '@jridgewell/gen-mapping@0.3.13': {}

  sucrase@3.35.1:
    dependencies:
      '@jridgewell/gen-mapping': 0.3.13
    transitivePeerDependencies:
      - supports-color

  vite@8.3.4(@types/node@22.0.0):
    optionalDependencies:
      fsevents: 2.3.3
`;

describe("pnpm-lock.yaml", () => {
	const lock = readLockfile(new Map([["pnpm-lock.yaml", PNPM]]))!;

	it("resolves the repository's dependencies, per workspace package", () => {
		expect(lock.fromRepo("test/a.test.ts", "sucrase")).toEqual({ key: "sucrase@3.35.1", name: "sucrase", version: "3.35.1" });
		expect(lock.fromRepo("packages/web/src/a.ts", "sucrase")?.version).toBe("3.0.0");
		expect(lock.fromRepo("test/a.test.ts", "vite")).toEqual({ key: "vite@8.3.4(@types/node@22.0.0)", name: "vite", version: "8.3.4" });
	});

	it("resolves a package's own dependencies from its snapshot", () => {
		const sucrase = lock.fromRepo("a.ts", "sucrase")!;
		expect(lock.fromPackage(sucrase, "@jridgewell/gen-mapping")?.version).toBe("0.3.13");
		expect(lock.fromPackage(lock.fromRepo("a.ts", "vite")!, "fsevents")?.version).toBe("2.3.3");
	});

	it("skips workspace links and unknown packages", () => {
		expect(lock.fromRepo("packages/web/a.ts", "shared")).toBeUndefined();
		expect(lock.fromRepo("a.ts", "left-pad")).toBeUndefined();
	});

	it("parses quoted keys and empty maps", () => {
		expect(parseYaml(PNPM).snapshots).toMatchObject({ "@jridgewell/gen-mapping@0.3.13": {} });
	});
});

describe("package-lock.json", () => {
	const lock = readLockfile(
		new Map([
			[
				"package-lock.json",
				JSON.stringify({
					packages: {
						"": { name: "app" },
						"node_modules/a": { version: "1.0.0" },
						"node_modules/b": { version: "2.0.0" },
						"node_modules/a/node_modules/b": { version: "1.5.0" },
					},
				}),
			],
		]),
	)!;

	it("follows Node's node_modules lookup", () => {
		const a = lock.fromRepo("index.test.js", "a")!;
		expect(a).toEqual({ key: "node_modules/a", name: "a", version: "1.0.0" });
		expect(lock.fromPackage(a, "b")?.version).toBe("1.5.0");
		expect(lock.fromRepo("index.test.js", "b")?.version).toBe("2.0.0");
	});
});
