import type { TestRun, TestRunDetail } from "../runs.ts";
import { esc, layout, renderHeader } from "./page.ts";

/** A run still "running" after this long was cut off (waitUntil ran out) and will never finish. */
export const STALE_AFTER_MS = 30 * 60_000;

const ICON = { success: "✓", failure: "✗", neutral: "–", cancelled: "⊘", running: "●", stale: "!" } as const;

const LIVE = '<script src="/admin/live.js" defer></script>';
/** Without JavaScript (or if the socket fails), running pages still reload on their own. */
const FALLBACK = '<noscript><meta http-equiv="refresh" content="5"></noscript>';

export function renderRunsPage(runs: TestRun[], email: string | undefined, now: number): string {
	const running = runs.some((r) => state(r, now) === "running");
	const rows = runs
		.map((run) => {
			const s = state(run, now);
			return `<tr>
				<td class="state ${s}"><a href="/admin/runs/${run.id}">${ICON[s]} ${LABEL[s]}</a></td>
				<td><a href="https://github.com/${esc(run.repo)}/pull/${run.pr}">${esc(run.repo)}#${run.pr}</a> <span class="mono">${esc(run.sha.slice(0, 7))}</span></td>
				<td>${s === "running" ? `<span data-progress="${run.id}">Preparando…</span>` : esc(run.title ?? "")}</td>
				<td class="num">${when(run.startedAt, now)}</td>
				<td class="num">${duration(run, now)}</td>
			</tr>`;
		})
		.join("");
	const table = runs.length
		? `<table><thead><tr><th>Estado</th><th>PR</th><th>Resultado</th><th class="num">Início</th><th class="num">Duração</th></tr></thead><tbody>${rows}</tbody></table>`
		: `<p class="empty">Nenhuma execução ainda. O check Tests roda quando está ativo num repositório e uma PR recebe commits.</p>`;
	return layout(
		"Execuções de testes",
		`${renderHeader(email, "runs")}
		<main data-live="all">
			<h2>Execuções de testes</h2>
			<p class="hint">As 50 execuções mais recentes do check Tests. A página acompanha ao vivo os testes que estão rodando.</p>
			${table}
		</main>`,
		`${LIVE}${running ? FALLBACK : ""}`,
	);
}

export function renderRunPage(run: TestRunDetail, email: string | undefined, now: number): string {
	const s = state(run, now);
	const files = run.report?.files ?? [];
	const fileRows = files
		.map((f) => {
			const passed = f.tests.filter((t) => t.state === "pass").length;
			const failed = f.errors?.length || f.tests.some((t) => t.state === "fail");
			return `<tr><td class="state ${failed ? "failure" : "success"}">${failed ? ICON.failure : ICON.success}</td><td class="mono">${esc(f.path)}</td><td class="num">${passed}/${f.tests.length}</td></tr>`;
		})
		.join("");
	const details = files
		.map(
			(f) => `<h3 class="mono">${esc(f.path)}</h3>
			${(f.errors ?? []).map((e) => `<pre>${esc(e)}</pre>`).join("")}
			<ul class="tests">${f.tests
				.map(
					(t) => `<li><span class="state ${testClass(t.state)}">${testIcon(t.state)}</span> ${esc(t.name)}${(t.errors ?? []).map((e) => `<pre>${esc(e)}</pre>`).join("")}</li>`,
				)
				.join("")}</ul>`,
		)
		.join("");
	const body =
		s === "running"
			? `<p data-progress="${run.id}">Preparando os testes…</p><ul class="tests" data-tests="${run.id}"></ul>`
			: s === "stale"
				? "<p>A execução foi interrompida antes de terminar: o Worker parou (limite de memória ou de tempo) sem registrar o resultado. Nada continua rodando. Rode de novo com <strong>Re-run</strong> na PR.</p>"
				: files.length
					? `<table><thead><tr><th></th><th>Arquivo</th><th class="num">Passaram</th></tr></thead><tbody>${fileRows}</tbody></table>${details}`
					: `<pre>${esc(run.summary ?? "")}</pre>`;
	return layout(
		`Execução ${run.id}`,
		`${renderHeader(email, "runs")}
		<main${s === "running" ? ` data-live="${run.id}"` : ""}>
			<p class="hint"><a href="/admin/runs">← Execuções de testes</a></p>
			<h2 class="state ${s}">${ICON[s]} ${esc(run.title ?? LABEL[s])}</h2>
			<p class="meta">
				<a href="https://github.com/${esc(run.repo)}/pull/${run.pr}">${esc(run.repo)}#${run.pr}</a>
				<span class="mono">${esc(run.sha)}</span>
				<span>${when(run.startedAt, now)}</span>
				<span>${duration(run, now)}</span>
			</p>
			${body}
		</main>`,
		s === "running" ? `${LIVE}${FALLBACK}` : "",
	);
}

type State = keyof typeof ICON;

const LABEL: Record<State, string> = {
	success: "Passou",
	failure: "Falhou",
	neutral: "Neutro",
	cancelled: "Cancelada",
	running: "Rodando",
	stale: "Interrompida",
};

function state(run: TestRun, now: number): State {
	if (run.status === "running") return now - run.startedAt > STALE_AFTER_MS ? "stale" : "running";
	return run.conclusion ?? "neutral";
}

const testIcon = (s: string) => (s === "pass" ? ICON.success : s === "fail" ? ICON.failure : ICON.neutral);
const testClass = (s: string) => (s === "pass" ? "success" : s === "fail" ? "failure" : "skip");

function duration(run: TestRun, now: number): string {
	// An interrupted run never ended; the time since it started is not how long anything ran.
	if (state(run, now) === "stale") return "—";
	const ms = (run.finishedAt ?? now) - run.startedAt;
	return ms < 1000 ? `${ms} ms` : ms < 60_000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1000)} s`;
}

function when(at: number, now: number): string {
	const s = Math.round((now - at) / 1000);
	if (s < 60) return "agora";
	if (s < 3600) return `há ${Math.floor(s / 60)} min`;
	if (s < 86_400) return `há ${Math.floor(s / 3600)} h`;
	return new Date(at).toISOString().slice(0, 10);
}
