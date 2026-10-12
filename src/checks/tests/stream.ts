import type { ProgressEvent, TestReport } from "./report.ts";

/** Reads the Dynamic Worker's newline-delimited JSON: progress events, then the report. */
export async function readRun(response: Response, onProgress: (event: ProgressEvent) => void): Promise<TestReport> {
	const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader();
	let buffer = "";
	try {
		for (;;) {
			const { value, done } = await reader.read();
			buffer += value ?? "";
			for (let end = buffer.indexOf("\n"); end !== -1; end = buffer.indexOf("\n")) {
				const line = buffer.slice(0, end);
				buffer = buffer.slice(end + 1);
				if (!line) continue;
				const event = JSON.parse(line) as ProgressEvent | { type: "report"; report: TestReport } | { type: "error"; message: string };
				if (event.type === "report") return event.report;
				if (event.type === "error") throw new Error(event.message);
				onProgress(event);
			}
			if (done) throw new Error("O Dynamic Worker terminou sem mandar o relatório.");
		}
	} finally {
		reader.cancel().catch(() => {});
	}
}
