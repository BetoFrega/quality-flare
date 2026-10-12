import { describe, expect, it } from "vitest";
import { toCheckResult } from "../../../src/checks/tests/report.ts";

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
