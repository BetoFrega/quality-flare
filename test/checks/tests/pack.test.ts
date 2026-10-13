import { describe, expect, it } from "vitest";
import { packFiles } from "../../../src/checks/tests/pack.ts";

const MB = 1_000_000;

describe("packFiles", () => {
	it("puts files that load the same code together, up to the bytes", () => {
		const measured = new Map([
			["a/1.test.ts", { react: 4 * MB, a: 1 * MB }],
			["b/1.test.ts", { node: 3 * MB }],
			["a/2.test.ts", { react: 4 * MB, a: 2 * MB }],
			["c/1.test.ts", { react: 4 * MB, c: 3 * MB }],
			["b/2.test.ts", { node: 3 * MB, b: 1 * MB }],
		]);
		expect(packFiles([...measured.keys()], measured, { bytes: 7 * MB, files: 10 })).toEqual([
			["a/1.test.ts", "a/2.test.ts"],
			["b/1.test.ts", "b/2.test.ts"],
			["c/1.test.ts"],
		]);
		expect(packFiles([...measured.keys()], measured, { bytes: 11 * MB, files: 10 })).toEqual([
			["a/1.test.ts", "a/2.test.ts", "b/1.test.ts", "b/2.test.ts"],
			["c/1.test.ts"],
		]);
	});

	it("caps the files per shard, and gives a file heavier than the bytes a shard of its own", () => {
		const measured = new Map([
			["a.test.ts", { huge: 50 * MB }],
			["b.test.ts", { x: 1 }],
			["c.test.ts", { x: 1 }],
			["d.test.ts", { x: 1 }],
		]);
		expect(packFiles([...measured.keys()], measured, { bytes: 10 * MB, files: 2 })).toEqual([["a.test.ts"], ["b.test.ts", "c.test.ts"], ["d.test.ts"]]);
	});

	it("counts files never measured as `unknown` bytes each, sharing nothing", () => {
		const files = ["a.test.ts", "b.test.ts", "c.test.ts", "d.test.ts", "e.test.ts"];
		expect(packFiles(files, new Map(), { bytes: 10 * MB, files: 30, unknown: 5 * MB })).toEqual([["a.test.ts", "b.test.ts"], ["c.test.ts", "d.test.ts"], ["e.test.ts"]]);
	});
});
