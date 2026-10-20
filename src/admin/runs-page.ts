import { RUN_SORTS, RUN_STATES, runState, STALE_AFTER_MS, type RunQuery, type RunSort, type TestRun, type TestRunDetail } from "../runs.ts";
import { RUN_DEADLINE_MS } from "../checks/tests/index.ts";
import type { AttemptRow, ContainerUsage, Usage } from "../metrics.ts";
import { boxCost, INSTANCE, type BoxUsage } from "../checks/tests/container.ts";
import { cpu, money, renderRunUsage, usageCells } from "./costs-page.ts";
import { esc, layout, renderHeader, select } from "./page.ts";

const ICON = { success: "✓", failure: "✗", neutral: "–", cancelled: "⊘", running: "●", stale: "!" } as const;

const LIVE = '<script src="/admin/live.js" defer></script>';
/** Without JavaScript (or if the socket fails), running pages still reload on their own. */
const FALLBACK = '<noscript><meta http-equiv="refresh" content="5"></noscript>';

const SORT_LABEL: Record<RunSort, string> = {
	recent: "Mais recentes",
	oldest: "Mais antigas",
	longest: "Mais demoradas",
	shortest: "Mais rápidas",
};

/** Reads the runs list's filter and sort from the query string, ignoring values it doesn't know. */
export function runQuery(params: URLSearchParams): RunQuery {
	const state = RUN_STATES.find((s) => s === params.get("state"));
	const sort = RUN_SORTS.find((s) => s === params.get("sort"));
	return { repo: params.get("repo") || undefined, state, sort };
}

export interface RunsPageData {
	runs: TestRun[];
	/** Repositories with runs, offered in the filter. */
	repos: string[];
	query: RunQuery;
	/** Each run's shard usage, by run id; runs from before it was recorded are absent. */
	usage?: Map<number, Usage>;
	/** Each Container tests run's container usage, by run id. */
	containers?: Map<number, ContainerUsage>;
	email?: string;
	now: number;
}

export function renderRunsPage({ runs, repos, query, usage = new Map(), containers = new Map(), email, now }: RunsPageData): string {
	const filtered = Boolean(query.repo || query.state);
	const running = runs.some((r) => runState(r, now) === "running");
	const late = runs.some((r) => overdue(r, now));
	const rows = runs
		.map((run) => {
			const s = runState(run, now);
			return `<tr>
				<td class="${stateClass(run, now)}"><a href="/admin/runs/${run.id}">${stateLabel(run, now)}</a></td>
				<td>${run.container ? "Container tests" : "Tests"}</td>
				<td>${target(run)} <span class="mono">${esc(run.sha.slice(0, 7))}</span></td>
				<td>${s === "running" ? `<span data-progress="${run.id}" role="status" aria-live="polite">Preparando…</span>` : esc(run.title ?? "")}</td>
				<td class="num">${when(run.startedAt, now)}</td>
				<td class="num">${duration(run, now)}</td>
				${usageCells(usage.get(run.id), containers.get(run.id))}
			</tr>`;
		})
		.join("");
	const table = runs.length
		? `<div class="scroll"><table><thead><tr><th>Estado</th><th>Check</th><th>Alvo</th><th>Resultado</th><th class="num">Início</th><th class="num">Duração</th><th class="num" title="Dynamic Workers criados (e quedas)">Workers</th><th class="num">Custo est.</th></tr></thead><tbody>${rows}</tbody></table></div>`
		: filtered
			? `<p class="empty">Nenhuma execução com esses filtros. <a href="/admin/runs">Limpar filtros</a></p>`
			: `<p class="empty">Nenhuma execução ainda. Os checks Tests e Container tests rodam quando estão ativos num repositório e uma PR recebe commits.</p>`;
	const filters = `<form class="filters" method="get" action="/admin/runs">
				${select("repo", "Repositório", query.repo ?? "", [["", "Todos os repositórios"], ...repos.map((r): [string, string] => [r, r])])}
				${select("state", "Estado", query.state ?? "", [["", "Todos os estados"], ...RUN_STATES.map((s): [string, string] => [s, LABEL[s]])])}
				${select("sort", "Ordenar", query.sort ?? "recent", RUN_SORTS.map((s): [string, string] => [s, SORT_LABEL[s]]))}
				<button type="submit" class="secondary">Aplicar</button>
				${filtered || (query.sort && query.sort !== "recent") ? '<a href="/admin/runs">Limpar</a>' : ""}
			</form>`;
	return layout(
		"Execuções de testes",
		`${renderHeader(email, "runs")}
		<main data-live="all">
			<h2>Execuções de testes</h2>
			<p class="hint">As 50 execuções mais recentes dos checks Tests e Container tests. A página acompanha ao vivo os testes que estão rodando.</p>
			${late ? `<p class="hint">${OVERDUE_HINT}</p>` : ""}
			${filters}
			${table}
		</main>`,
		`${LIVE}${running ? FALLBACK : ""}`,
	);
}

export function renderRunPage(
	run: TestRunDetail,
	email: string | undefined,
	now: number,
	{ usage, attempts = [], container }: { usage?: Usage; attempts?: AttemptRow[]; container?: BoxUsage } = {},
): string {
	const s = runState(run, now);
	const files = run.report?.files ?? [];
	// Failures first, each with the file it is in: a file's own errors (it didn't load), then its failing tests.
	const failures = files.flatMap((f) => [
		...(f.errors ?? []).map((e) => failure(f.path, "erro no arquivo", [e])),
		...f.tests.filter((t) => t.state === "fail").map((t) => failure(f.path, t.name, t.errors ?? [])),
	]);
	const fileList = files
		.map((f) => {
			const passed = f.tests.filter((t) => t.state === "pass").length;
			const failed = Boolean(f.errors?.length || f.tests.some((t) => t.state === "fail"));
			return `<details class="plain"${failed ? " open" : ""}><summary><span class="state ${failed ? "failure" : "success"}">${icon(failed ? "failure" : "success")} ${failed ? LABEL.failure : LABEL.success}</span> <span class="mono">${esc(f.path)}</span> <span class="count">${passed}/${f.tests.length} passaram</span></summary>
				<ul class="tests">${f.tests.map((t) => `<li>${testIcon(t.state)} ${esc(t.name)}</li>`).join("")}</ul>
			</details>`;
		})
		.join("");
	const report = `${failures.length ? `<h3>Falhas</h3><ul class="tests">${failures.join("")}</ul>` : ""}<h3>Arquivos</h3>${fileList}`;
	const body =
		s === "running"
			? `<p data-progress="${run.id}" role="status" aria-live="polite">Preparando os testes…</p><ul class="tests" data-tests="${run.id}"></ul>`
			: s === "stale"
				? "<p>A execução foi interrompida antes de terminar: o Worker parou (limite de memória ou de tempo) sem registrar o resultado. Nada continua rodando. Rode de novo com <strong>Re-run</strong> na PR.</p>"
				: files.length
					? report
					: `<pre>${esc(run.summary ?? "")}</pre>`;
	return layout(
		`Execução ${run.id}`,
		`${renderHeader(email, "runs")}
		<main${s === "running" ? ` data-live="${run.id}"` : ""}>
			<p class="hint"><a href="/admin/runs">← Execuções de testes</a></p>
			<h2 class="${stateClass(run, now)}">${s === "running" ? stateLabel(run, now) : `${icon(s)} ${esc(run.title ?? LABEL[s])}`}</h2>
			<p class="meta">
				<span>${run.container ? "Container tests" : "Tests"}</span>
				${target(run)}
				${run.pr ? `<a class="mono" href="https://github.com/${esc(run.repo)}/commit/${esc(run.sha)}">${esc(run.sha)}</a>` : `<span class="mono">${esc(run.sha)}</span>`}
				<span>${when(run.startedAt, now)}</span>
				<span>${duration(run, now)}</span>
			</p>
			${overdue(run, now) ? `<p class="hint">${OVERDUE_HINT}</p>` : ""}
			${body}
			${renderUsage(usage, attempts, now, s !== "running", container)}
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

/** A state's icon, hidden from screen readers: the label next to it says the same. */
const icon = (s: State) => `<span aria-hidden="true">${ICON[s]}</span>`;

/** A test's icon, the only sign of its state, so it is read out as one. */
function testIcon(state: string): string {
	const [s, css, label] = state === "pass" ? (["success", "success", "passou"] as const) : state === "fail" ? (["failure", "failure", "falhou"] as const) : (["neutral", "skip", "ignorado"] as const);
	return `<span class="state ${css}" role="img" aria-label="${label}">${ICON[s]}</span>`;
}

function failure(file: string, name: string, errors: string[]): string {
	return `<li>${testIcon("fail")} <span class="mono">${esc(file)}</span> › ${esc(name)}${errors.map((e) => `<pre>${esc(e)}</pre>`).join("")}</li>`;
}

/**
 * A run past its deadline should already have been failed by the cron (src/checks/tests/index.ts);
 * until it shows as interrupted (STALE_AFTER_MS), it is flagged as probably stuck.
 */
const overdue = (run: TestRun, now: number) => runState(run, now) === "running" && now - run.startedAt > RUN_DEADLINE_MS;

const OVERDUE_HINT = `Uma execução rodando há mais de ${RUN_DEADLINE_MS / 60_000} min passou do prazo e provavelmente travou. Aos ${STALE_AFTER_MS / 60_000} min ela aparece como interrompida.`;

const stateClass = (run: TestRun, now: number) => `state ${runState(run, now)}${overdue(run, now) ? " overdue" : ""}`;

/** The state's icon and label; a running run also says for how long, and whether it is past its deadline. */
function stateLabel(run: TestRun, now: number): string {
	const s = runState(run, now);
	if (s !== "running") return `${icon(s)} ${LABEL[s]}`;
	const min = Math.floor((now - run.startedAt) / 60_000);
	return `${icon(s)} ${LABEL[s]}${min ? ` há ${min} min` : ""}${overdue(run, now) ? " · passou do prazo" : ""}`;
}

function duration(run: TestRun, now: number): string {
	// An interrupted run never ended; the time since it started is not how long anything ran.
	if (runState(run, now) === "stale") return "—";
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

/** The run page's one usage section: the Dynamic Workers' (from the costs page), then the container's. */
function renderUsage(u: Usage | undefined, attempts: AttemptRow[], now: number, over: boolean, container: BoxUsage | undefined): string {
	const workers = renderRunUsage(u, attempts, now, over);
	if (!container) return workers;
	// The container's numbers go under the workers' heading when there is one.
	return workers ? `${workers}${containerStats(container)}` : `<section class="usage"><h3>Uso e custo</h3>${containerStats(container)}</section>`;
}

/** Usage of a run on the "Container" runner. */
function containerStats(u: BoxUsage): string {
	const items: [string, string][] = [
		["Custo estimado", money(boxCost(u))],
		["Container", `${INSTANCE.name} (${INSTANCE.vcpu} vCPU, ${INSTANCE.memoryGiB} GiB)`],
		["Tempo ligado", cpu(u.wallMs)],
		["CPU usada", u.cpuUs === undefined ? "—" : cpu(Math.round(u.cpuUs / 1000))],
	];
	return `<dl class="stats">${items.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join("")}</dl>
		<p class="hint">Estimativa sem a franquia mensal: memória e disco pelo tempo ligado, CPU pelo que foi usado.</p>`;
}

/** The PR a run tested, or the commit for a full run, which has none (pr 0). */
function target(run: Pick<TestRun, "repo" | "pr" | "sha">): string {
	if (!run.pr) return `<a href="https://github.com/${esc(run.repo)}/commit/${esc(run.sha)}">${esc(run.repo)} (run completa)</a>`;
	return `<a href="https://github.com/${esc(run.repo)}/pull/${run.pr}">${esc(run.repo)}#${run.pr}</a>`;
}
