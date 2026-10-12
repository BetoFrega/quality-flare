import { describe, expect, it } from "vitest";
import { globToRegExp, readTestConfig, selectTestFiles } from "../../../src/checks/tests/config.ts";
import { isTestFile } from "../../../src/checks/tests/convention.ts";

const PATHS = [
	"src/a.test.ts",
	"src/ui/b.test.tsx",
	"src/c.integration.test.ts",
	"apps/api/adapters/d.test.ts",
	"apps/api/tests/e.runtime.test.ts",
	"tests/e2e/f.spec.ts",
	"src/node_modules/x/g.test.ts",
];

describe("quality-flare.json tests config", () => {
	it("matches globs as vitest writes them", () => {
		expect(globToRegExp("src/**/*.test.{ts,tsx}").test("src/ui/b.test.tsx")).toBe(true);
		expect(globToRegExp("src/**/*.test.{ts,tsx}").test("src/a.test.ts")).toBe(true);
		expect(globToRegExp("**/*.integration.test.{ts,tsx}").test("src/c.integration.test.ts")).toBe(true);
		expect(globToRegExp("apps/**/adapters/**/*.test.ts").test("apps/api/adapters/d.test.ts")).toBe(true);
		expect(globToRegExp("./bin/*.test.ts").test("bin/x.test.ts")).toBe(true);
		expect(globToRegExp("src/*.test.ts").test("src/ui/b.test.ts")).toBe(false);
	});

	it("picks test files by include and exclude, never from node_modules", () => {
		const config = readTestConfig(
			JSON.stringify({ tests: { include: ["src/**/*.test.{ts,tsx}", "apps/**/adapters/**/*.test.ts"], exclude: ["**/*.integration.test.{ts,tsx}"] } }),
		);
		expect(selectTestFiles(PATHS, config, isTestFile)).toEqual(["src/a.test.ts", "src/ui/b.test.tsx", "apps/api/adapters/d.test.ts"]);
	});

	it("falls back to the convention without include", () => {
		expect(selectTestFiles(PATHS, readTestConfig(undefined), isTestFile)).toEqual([
			"src/a.test.ts",
			"src/c.integration.test.ts",
			"apps/api/adapters/d.test.ts",
			"apps/api/tests/e.runtime.test.ts",
			"tests/e2e/f.spec.ts",
		]);
	});

	it("says what is wrong with an invalid file", () => {
		expect(() => readTestConfig("{")).toThrow("quality-flare.json não é um JSON válido");
		expect(() => readTestConfig(JSON.stringify({ tests: { include: "src" } }))).toThrow('"tests.include" deve ser uma lista de textos');
	});
});
