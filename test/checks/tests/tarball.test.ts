import { describe, expect, it } from "vitest";
import { followLinks, readTarball } from "../../../src/checks/tests/tarball.ts";
import { tarball } from "./tar.ts";

describe("readTarball", () => {
	it("drops GitHub's top-level folder and keeps only the files asked for", async () => {
		const files = await readTarball(
			tarball({ "src/a.ts": "export const a = 1;", "README.md": "# hi", "test/a.test.ts": "it()" }),
			(p) => p.endsWith(".ts"),
		);
		expect(Object.fromEntries(files)).toEqual({ "src/a.ts": "export const a = 1;", "test/a.test.ts": "it()" });
	});

	it("reads long paths from PAX headers", async () => {
		const path = `${"deep/".repeat(25)}a.test.ts`;
		const files = await readTarball(tarball({ [path]: "ok" }), () => true);
		expect(files.get(path)).toBe("ok");
	});
});

describe("followLinks", () => {
	it("copies what a link points at: a file, or every file under a folder", () => {
		const files = new Map([
			[".agents/skills/a/SKILL.md", "# A"],
			[".agents/README.md", "readme"],
		]);
		followLinks(files, new Map([[".claude/skills", "../.agents/skills"], ["README.md", ".agents/README.md"], ["out", "../../etc"]]));
		expect(files.get(".claude/skills/a/SKILL.md")).toBe("# A");
		expect(files.get("README.md")).toBe("readme");
		expect(files.size).toBe(4);
	});
});
