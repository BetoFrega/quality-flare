import { describe, expect, it } from "vitest";
import { parseClosingRefs } from "../../src/checks/closes-issue/keywords.ts";

describe("parseClosingRefs", () => {
	it.each([
		["Closes #12", [{ number: 12 }]],
		["fixes #1", [{ number: 1 }]],
		["Resolved: #7", [{ number: 7 }]],
		["This FIXED #3.", [{ number: 3 }]],
		["close octo/repo#45", [{ repo: "octo/repo", number: 45 }]],
		["Resolves https://github.com/octo/repo/issues/9", [{ repo: "octo/repo", number: 9 }]],
		["Closes #1, fixes #2\nresolves #1", [{ number: 1 }, { number: 2 }]],
	])("finds refs in %j", (text, expected) => {
		expect(parseClosingRefs(text)).toEqual(expected);
	});

	it.each([
		[null],
		[""],
		["Related to #12"],
		["See #12"],
		["prefixes #12"],
		["closes#12"],
		["Closes https://github.com/octo/repo/pull/9"],
		["`Closes #12`"],
		["```\nCloses #12\n```"],
		["Closes #12abc"],
	])("ignores %j", (text) => {
		expect(parseClosingRefs(text)).toEqual([]);
	});
});
