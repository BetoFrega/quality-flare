import type { CheckResult } from "../types.ts";
import type { Unresolved } from "./modules.ts";

/** What the Dynamic Worker sends back after running the tests. */
export interface TestReport {
	files: {
		/** Repository path, e.g. "test/a.test.ts". */
		path: string;
		state: string;
		/** Errors outside any test: the file failed to import, or a beforeAll/afterAll hook threw. */
		errors?: string[];
		tests: TestResult[];
	}[];
}

export interface TestResult {
	/** Suite names and the test name, joined with " › ". */
	name: string;
	/** "pass", "fail", "skip" or "todo". */
	state: string;
	errors?: string[];
}

/** Streamed by the Dynamic Worker while tests run, before the final report. */
export type ProgressEvent =
	| { type: "collected"; total: number }
	| ({ type: "test"; file: string } & TestResult)
	/** What the run is doing before tests report, e.g. "Lote 3: montando 20 arquivos". */
	| { type: "status"; text: string };

/** Joins the reports of a run's shards, files in path order, and their unresolved imports. */
export function mergeReports(parts: { report: TestReport; unresolved: Unresolved[] }[]): {
	report: TestReport;
	unresolved: Unresolved[];
} {
	const files = parts.flatMap((p) => p.report.files).sort((a, b) => a.path.localeCompare(b.path));
	const seen = new Set<string>();
	const unresolved = parts
		.flatMap((p) => p.unresolved)
		.filter((u) => {
			const key = `${u.from}\0${u.specifier}`;
			return !seen.has(key) && seen.add(key);
		});
	return { report: { files }, unresolved };
}

/** GitHub caps a check run summary at 65535 characters. */
const MAX_SUMMARY = 60_000;

export function toCheckResult(report: TestReport, unresolved: Unresolved[] = []): CheckResult {
	const tests = report.files.flatMap((f) => f.tests);
	const passed = tests.filter((t) => t.state === "pass").length;
	const skipped = tests.filter((t) => t.state === "skip" || t.state === "todo").length;
	const failedTests = report.files.flatMap((f) => f.tests.filter((t) => t.state === "fail").map((t) => ({ file: f.path, ...t })));
	const brokenFiles = report.files.filter((f) => f.errors?.length);
	const fileCount = `${report.files.length} arquivo${report.files.length === 1 ? "" : "s"}`;

	if (!failedTests.length && !brokenFiles.length) {
		return {
			conclusion: "success",
			title: `${passed} teste${passed === 1 ? "" : "s"} passaram`,
			summary: `${passed} passaram${skipped ? `, ${skipped} pulados` : ""} em ${fileCount}.\n\n${fileTable(report)}`,
		};
	}

	const sections = [
		...(unresolved.length
			? [`### Imports não resolvidos\n\n${unresolved.map((u) => `- \`${u.specifier}\` em \`${u.from}\`${u.reason ? `: ${u.reason}` : ""}`).join("\n")}`]
			: []),
		...brokenFiles.map((f) => `### \`${f.path}\`\n\n${f.errors!.map(codeBlock).join("\n")}`),
		...failedTests.map((t) => `### ${t.name}\n\`${t.file}\`\n\n${(t.errors ?? []).map(codeBlock).join("\n")}`),
	];
	const failures = failedTests.length + brokenFiles.length;
	let summary = `${failedTests.length} falharam, ${passed} passaram${skipped ? `, ${skipped} pulados` : ""} em ${fileCount}.\n\n${fileTable(report)}\n\n## Falhas\n\n${sections.join("\n\n")}`;
	if (summary.length > MAX_SUMMARY) summary = `${summary.slice(0, MAX_SUMMARY)}\n\n…(cortado)`;
	return {
		conclusion: "failure",
		title: `${failures} falha${failures === 1 ? "" : "s"} em ${tests.length} teste${tests.length === 1 ? "" : "s"}`,
		summary,
	};
}

function fileTable(report: TestReport): string {
	const rows = report.files.map((f) => {
		const ok = f.tests.filter((t) => t.state === "pass").length;
		const icon = f.errors?.length || f.tests.some((t) => t.state === "fail") ? "❌" : "✅";
		return `| ${icon} | \`${f.path}\` | ${ok}/${f.tests.length} |`;
	});
	return ["| | Arquivo | Passaram |", "| --- | --- | --- |", ...rows].join("\n");
}

const codeBlock = (text: string) => `\`\`\`\n${text.replaceAll("```", "ʼʼʼ")}\n\`\`\``;

/** What the Dynamic Worker is asked to run: module paths, and the vitest options that apply. */
export interface RunRequest {
	files: string[];
	setupFiles?: string[];
	globals?: boolean;
	testTimeout?: number;
}
