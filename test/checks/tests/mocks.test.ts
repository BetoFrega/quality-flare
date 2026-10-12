import { describe, expect, it } from "vitest";
import { bindingNames, rewriteImportActual, splitMocks } from "../../../src/checks/tests/mocks.ts";

describe("splitMocks", () => {
	it("moves top-level vi.mock and vi.hoisted out, keeping lines and other code", () => {
		const js = [
			`import { greet } from "./greet";`,
			`const { a, b: c } = vi.hoisted(() => ({ a: 1, b: ")" }));`,
			`vi.mock("./clock", () => ({ now: () => \`\${a} ) \${"}"}\` }));`,
			`describe("x", () => { vi.mock("./inner"); });`,
			`// vi.mock("./commented")`,
		].join("\n");
		const split = splitMocks(js)!;
		expect(split.specs).toEqual(["./clock"]);
		expect(split.names).toEqual(["a", "c"]);
		expect(split.hoisted).toBe(
			`const { a, b: c } = vi.hoisted(() => ({ a: 1, b: ")" }));\nvi.mock(__QF_MOCK_0__, () => ({ now: () => \`\${a} ) \${"}"}\` }));`,
		);
		expect(split.rest.split("\n")).toHaveLength(5);
		expect(split.rest).toContain(`describe("x", () => { vi.mock("./inner"); });`);
		expect(split.rest).not.toContain("hoisted");
	});

	it("leaves a file without mocks alone", () => {
		expect(splitMocks(`it("a", () => vi.fn());`)).toBeUndefined();
	});
});

describe("bindingNames", () => {
	it("reads identifiers, object and array patterns", () => {
		expect(bindingNames("mocks")).toEqual(["mocks"]);
		expect(bindingNames("{ a, b: c, d = 1, ...e }")).toEqual(["a", "c", "d", "e"]);
		expect(bindingNames("[x, , { y }]")).toEqual(["x", "y"]);
	});
});

it("rewriteImportActual points vi.importActual at the real module", () => {
	expect(rewriteImportActual(`await vi.importActual("./x")`)).toBe(`await import("./x?__qf_actual")`);
});
