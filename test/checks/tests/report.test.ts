import { describe, expect, it } from "vitest";
import { toCheckResult } from "../../../src/checks/tests/report.ts";
import { readRun } from "../../../src/checks/tests/stream.ts";

describe("toCheckResult", () => {
	it("passes when every test passes", () => {
		const result = toCheckResult({
			files: [{ path: "test/a.test.ts", state: "pass", tests: [{ name: "a › works", state: "pass" }, { name: "b", state: "skip" }] }],
		});
		expect(result).toMatchObject({ conclusion: "success", title: "1 teste passaram" });
		expect(result.summary).toContain("| ✅ | `test/a.test.ts` | 1/2 |");
	});

	it("fails with each failing test and broken file", () => {
		const result = toCheckResult(
			{
				files: [
					{ path: "test/a.test.ts", state: "fail", tests: [{ name: "a › adds", state: "fail", errors: ["AssertionError: expected 3 to be 4"] }] },
					{ path: "test/b.test.ts", state: "fail", errors: ["Error: boom"], tests: [] },
				],
			},
			[{ specifier: "left-pad", from: "test/b.test.ts" }],
		);
		expect(result).toMatchObject({ conclusion: "failure", title: "2 falhas em 1 teste" });
		expect(result.summary).toContain("### a › adds\n`test/a.test.ts`\n\n```\nAssertionError: expected 3 to be 4\n```");
		expect(result.summary).toContain("### `test/b.test.ts`\n\n```\nError: boom\n```");
		expect(result.summary).toContain("- `left-pad` em `test/b.test.ts`");
	});
});

describe("readRun", () => {
	const stream = (...chunks: string[]) =>
		new Response(new Blob(chunks).stream());

	it("hands progress over as it arrives and returns the report", async () => {
		const progress: unknown[] = [];
		const report = await readRun(
			stream('{"type":"collected","total":1}\n{"type":"test","file":"a","na', 'me":"x","state":"pass"}\n', '{"type":"report","report":{"files":[]}}\n'),
			(e) => progress.push(e),
		);
		expect(report).toEqual({ files: [] });
		expect(progress).toEqual([{ type: "collected", total: 1 }, { type: "test", file: "a", name: "x", state: "pass" }]);
	});

	it("fails when the worker reports an error or stops early", async () => {
		await expect(readRun(stream('{"type":"error","message":"boom"}\n'), () => {})).rejects.toThrow("boom");
		await expect(readRun(stream('{"type":"collected","total":1}\n'), () => {})).rejects.toThrow("sem mandar o relatório");
	});
});
