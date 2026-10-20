import { dayCost, monthOverage, type AccountUsage } from "../account-usage.ts";
import { CONTAINER_PRICES, INSTANCE } from "../checks/tests/container.ts";
import { boxResources, CONTAINER_INCLUDED, containerCost, containerOverage, type ContainerResources } from "../container-costs.ts";
import { cost, INCLUDED, LOST_AFTER_MS, monthCost, PRICES, type AttemptRow, type ContainerRow, type ContainerUsage, type ShardOutcome, type Usage, type UsageRow } from "../metrics.ts";
import { esc, layout, renderHeader, select } from "./page.ts";

/** Usage and estimated cost: the run pages' "Uso" section and the /admin/costs page. */

export function money(usd: number): string {
	const digits = usd < 0.01 ? 4 : 2;
	return usd === 0 ? "US$ 0" : `US$ ${usd.toLocaleString("pt-BR", { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
}

export function cpu(ms: number): string {
	const one = (value: number) => value.toLocaleString("pt-BR", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
	return ms < 1000 ? `${ms} ms` : ms < 60_000 ? `${one(ms / 1000)} s` : ms < 3_600_000 ? `${one(ms / 60_000)} min` : `${one(ms / 3_600_000)} h`;
}

const n = (value: number) => value.toLocaleString("pt-BR");

/** A container's estimated gross cost: memory and disk for the time it was on, CPU as used. */
export const boxesCost = (c: ContainerUsage) => containerCost(boxResources(c.wallMs, c.cpuUs));

/** Cells for a run in the runs list: Dynamic Workers and estimated cost, Dynamic Workers and container together. */
export function usageCells(u: Usage | undefined, box?: ContainerUsage): string {
	if (!u && !box) return '<td class="num">—</td><td class="num">—</td>';
	const trouble = u?.crashes ? ` <span class="failure" title="Dynamic Workers que caíram">${u.crashes}✗</span>` : "";
	const dw = u ? `${n(u.dynamicWorkers)}${trouble}` : '<span title="Rodou num container">—</span>';
	return `<td class="num">${dw}</td><td class="num">${money((u ? cost(u) : 0) + (box ? boxesCost(box) : 0))}</td>`;
}

const OUTCOME: Record<ShardOutcome, string> = {
	ran: "Rodou",
	rechecked: "Rodou; falhas de novo sozinhas",
	split: "Dividido (queda antes)",
	crashed: "Dynamic Worker caiu; dividido",
	"too-large": "Código grande demais; dividido",
	expired: "Passou do prazo",
	"gave-up": "Desistiu após quedas",
	failed: "Não rodou (erro)",
	skipped: "Ignorado (execução encerrada)",
	error: "Erro; vai de novo",
};

/** A label, its value and, optionally, what the label means. */
type Stat = [string, string, string?];

function statList(items: Stat[]): string {
	return `<dl class="stats">${items.map(([k, v, title]) => `<div><dt${title ? ` title="${esc(title)}"` : ""}>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join("")}</dl>`;
}

/** What the counts with less obvious names mean, for their labels' titles. */
const MEANING = {
	attempts: "Cada grupo de arquivos de teste que a fila entregou a um Dynamic Worker; um lote repetido conta de novo.",
	retries: "Lotes que a fila entregou de novo depois de um erro.",
	crashes: "Em geral por falta de memória; o lote é dividido e roda de novo.",
	splits: "Lotes partidos em lotes menores depois de uma queda.",
};

/** The numbers that drive the cost first; the ones that explain them after. */
const mainStats = (u: Usage): Stat[] => [
	["Custo estimado", money(cost(u))],
	["Dynamic Workers", n(u.dynamicWorkers)],
	["CPU dos Dynamic Workers", cpu(u.cpuMs)],
];
const detailStats = (u: Usage): Stat[] => [
	["Lotes executados", n(u.attempts), MEANING.attempts],
	["Tempo somado dos lotes", cpu(u.wallMs)],
	["Lotes repetidos", n(u.retries), MEANING.retries],
	["Dynamic Workers que caíram", n(u.crashes), MEANING.crashes],
	["Lotes divididos", n(u.splits), MEANING.splits],
];

/** The run page's usage section: totals and every shard attempt. In a run that is over, an attempt that never ended crashed. */
export function renderRunUsage(u: Usage | undefined, attempts: AttemptRow[], now: number, over: boolean): string {
	if (!u || !attempts.length) return "";
	const rows = attempts
		.map((a) => {
			const lost = !a.outcome && (over || (a.startedAt ?? now) < now - LOST_AFTER_MS);
			const outcome = a.outcome ? OUTCOME[a.outcome] : lost ? "Caiu (Worker da fila sem memória?)" : "Rodando";
			const dw = a.dwOutcome && a.dwOutcome !== "ok" ? ` <span class="failure">${esc(a.dwOutcome)}</span>` : "";
			return `<tr>
				<td class="mono">${esc(a.shard)}${a.attempt > 1 ? ` #${a.attempt}` : ""}</td>
				<td class="num">${a.files ?? "—"}</td>
				<td class="${lost || a.outcome === "crashed" ? "failure" : ""}">${esc(outcome)}${dw}</td>
				<td class="num">${a.codeBytes ? `${(a.codeBytes / 1024 / 1024).toFixed(1)} MB` : "—"}</td>
				<td class="num">${a.startedAt && a.finishedAt ? cpu(a.finishedAt - a.startedAt) : "—"}</td>
				<td class="num">${a.cpuMs !== null ? cpu(a.cpuMs) : "—"}</td>
			</tr>`;
		})
		.join("");
	return `<section class="usage">
		<h3>Uso e custo</h3>
		${statList([...mainStats(u), ...detailStats(u)])}
		<p class="hint">Estimativa sem a franquia mensal. Não inclui o CPU do Worker da fila, que monta o código dos lotes.</p>
		<details class="plain"><summary>${n(attempts.length)} entregas de lotes</summary>
			<div class="scroll"><table><thead><tr><th>Lote</th><th class="num">Arquivos</th><th>Resultado</th><th class="num">Código</th><th class="num">Tempo</th><th class="num">CPU do DW</th></tr></thead><tbody>${rows}</tbody></table></div>
		</details>
	</section>`;
}


export interface CostsPageData {
	days: UsageRow[];
	months: UsageRow[];
	repos: string[];
	repo?: string;
	/** The account's real usage, or why it couldn't be read. */
	account?: AccountUsage | string;
	/** Container tests runs, per day and per month. */
	containerDays?: ContainerRow[];
	containerMonths?: ContainerRow[];
	email?: string;
}

const hours = (seconds: number) => (seconds / 3600).toLocaleString("pt-BR", { maximumFractionDigits: 1 });

/** A unit price, as small as it is: "US$ 0,0000025". */
const price = (usd: number) => `US$ ${usd.toLocaleString("pt-BR", { maximumSignificantDigits: 3 })}`;

const BILLING = '<a href="https://dash.cloudflare.com/?to=/:account/billing">Billing &gt; Billable Usage</a>';

/** Something that counts against a monthly allowance. */
interface Allowance {
	label: string;
	used: number;
	included: number;
	format: (value: number) => string;
}

/** Container usage against the monthly allowance, as Cloudflare bills it. */
function containerAllowances(r: ContainerResources): Allowance[] {
	return [
		{ label: "Memória dos containers", used: r.memoryGiBs, included: CONTAINER_INCLUDED.memoryGiBs, format: (v) => `${hours(v)} GiB-h` },
		{ label: "CPU dos containers", used: r.vcpuS, included: CONTAINER_INCLUDED.vcpuS, format: (v) => `${n(Math.round(v / 60))} vCPU-min` },
		{ label: "Disco dos containers", used: r.diskGBs, included: CONTAINER_INCLUDED.diskGBs, format: (v) => `${hours(v)} GB-h` },
	];
}

function accountAllowances(month: AccountUsage["month"]): Allowance[] {
	return [
		{ label: "Dynamic Workers", used: month.dynamicWorkers, included: INCLUDED.dynamicWorkers, format: n },
		{ label: "CPU da conta", used: month.accountCpuMs, included: INCLUDED.cpuMs, format: cpu },
		...containerAllowances(month.containers),
	];
}

const share = (a: Allowance) => a.used / a.included;

function percent(a: Allowance): string {
	const value = share(a) * 100;
	return value > 0 && value < 1 ? "<1%" : `${n(Math.round(value))}%`;
}

/** Each allowance as "used de included", its share and a bar; the text carries everything the bar shows. */
function renderAllowances(items: Allowance[]): string {
	return `<dl class="stats meters">${items
		.map((a) => {
			return `<div><dt>${esc(a.label)}</dt><dd>${esc(a.format(a.used))} de ${esc(a.format(a.included))} <span class="pct${share(a) > 1 ? " failure" : ""}">${esc(percent(a))}</span><meter min="0" max="${a.included}" value="${a.used}" high="${a.included * 0.8}" optimum="0" aria-hidden="true"></meter></dd></div>`;
		})
		.join("")}</dl>`;
}

/** A collapsed note on where the numbers come from, kept out of the way of the numbers. */
const how = (summary: string, text: string) => `<details class="plain"><summary>${summary}</summary><p class="hint">${text}</p></details>`;

const containerRuns = (r: ContainerRow) => boxResources(r.wallMs, r.cpuUs);

/**
 * The page's answer: is the month still inside the allowance? From what Cloudflare measured when
 * it could be read, otherwise from the estimates (which only see the tests, maybe of one repository).
 */
function renderLead(account: AccountUsage | string | undefined, tests: UsageRow | undefined, boxes: ContainerRow | undefined, repo: string | undefined): string {
	const verdict = (period: string, over: number) => `da franquia em ${esc(period)}: ${money(over)} a pagar até agora`;
	const box = (over: number, text: string, note: string) => `<div class="lead${over ? " over" : ""}"><p class="verdict">${text}</p><p class="hint">${note}</p></div>`;
	if (account && typeof account !== "string") {
		const over = monthOverage(account.month);
		const closest = accountAllowances(account.month).reduce((a, b) => (share(b) > share(a) ? b : a));
		return box(
			over,
			`${over ? "Acima" : "Dentro"} ${verdict(account.month.period, over)}`,
			`Medido pelo Cloudflare na conta inteira. Maior uso: ${esc(closest.label)}, ${esc(percent(closest))} da franquia. Mês do calendário em UTC; o valor cobrado de verdade está em ${BILLING}.`,
		);
	}
	const why = typeof account === "string" ? "O uso medido da conta não pôde ser lido" : "O uso medido da conta não está disponível";
	const period = tests?.period ?? boxes?.period;
	if (!period) return box(0, "Nenhum uso registrado neste mês", `${why}, e os testes não registraram uso.`);
	const over = (tests ? monthCost(tests) : 0) + (boxes ? containerOverage(containerRuns(boxes)) : 0);
	return box(
		over,
		`Estimativa: ${over ? "acima" : "dentro"} ${verdict(period, over)}`,
		`${why} (<a href="#conta">detalhes</a>). A estimativa só vê os testes${repo ? ` de ${esc(repo)}` : ""}; outros Workers da conta dividem a mesma franquia.`,
	);
}

/** What Cloudflare measured on the whole account: the numbers it bills, without per-run detail. */
function renderAccount(account: AccountUsage | string | undefined): string {
	if (account === undefined) return "";
	if (typeof account === "string")
		return `<section id="conta"><h3>Uso medido da conta</h3><p class="hint failure">Não deu para ler o uso real da conta: ${esc(account)}</p></section>`;
	const { month, days } = account;
	const rows = days
		.map(
			(d) => `<tr>
			<td class="mono">${esc(d.date)}</td>
			<td class="num">${n(d.dynamicWorkers)}</td>
			<td class="num">${cpu(d.cpuMs)}</td>
			<td class="num">${n(d.requests)}</td>
			<td class="num${d.errors ? " failure" : ""}">${n(d.errors)}</td>
			<td class="num">${cpu(d.accountCpuMs)}</td>
			<td class="num">${money(containerCost(d.containers))}</td>
			<td class="num">${money(dayCost(d))}</td>
		</tr>`,
		)
		.join("");
	const more: Stat[] = [
		["CPU do quality-flare", cpu(month.cpuMs), "O CPU deste Worker (webhook, fila e cron), já somado ao CPU da conta."],
		["Invocações com erro", n(month.errors)],
		["Containers após franquia", money(containerOverage(month.containers))],
	];
	return `<section id="conta">
		<h3>Uso medido da conta, mês ${esc(month.period)}</h3>
		${renderAllowances(accountAllowances(month))}
		<details class="plain"><summary>Mais números do mês</summary>${statList(more)}</details>
		${
			days.length
				? `<details class="plain"><summary>Por dia (últimos 30 dias)</summary><div class="scroll"><table><thead><tr><th>Dia</th><th class="num">Dynamic Workers</th><th class="num">CPU do quality-flare</th><th class="num">Invocações</th><th class="num">Erros</th><th class="num">CPU da conta</th><th class="num">Containers</th><th class="num">Custo bruto</th></tr></thead><tbody>${rows}</tbody></table></div></details>`
				: ""
		}
		${how(
			"Como medimos",
			`Números do Cloudflare Analytics para a conta inteira, sem separar por execução. A cobrança é o que passa da franquia do mês do calendário (UTC); o ciclo de cobrança pode ser outro. Containers contam memória e disco pelo tempo ligado e a CPU usada. Requisições e fila ficam dentro da franquia e não aparecem. O valor cobrado de verdade está em ${BILLING}.`,
		)}
	</section>`;
}

/** Estimates for the Tests check, from what each shard attempt recorded. */
function renderTests(days: UsageRow[], months: UsageRow[]): string {
	const head = `<tr><th>Período</th><th class="num">Execuções</th><th class="num" title="${MEANING.attempts}">Lotes</th><th class="num" title="${MEANING.retries}">Repetidos</th><th class="num" title="${MEANING.crashes}">Quedas</th><th class="num">Dynamic Workers</th><th class="num">CPU dos DW</th><th class="num">Custo</th>`;
	const row = (r: UsageRow, month: boolean) => `<tr>
		<td class="mono">${esc(r.period)}</td>
		<td class="num">${n(r.runs)}</td>
		<td class="num">${n(r.attempts)}</td>
		<td class="num">${n(r.retries)}</td>
		<td class="num${r.crashes ? " failure" : ""}">${n(r.crashes)}</td>
		<td class="num">${n(r.dynamicWorkers)}</td>
		<td class="num">${cpu(r.cpuMs)}</td>
		<td class="num">${money(cost(r))}</td>
		${month ? `<td class="num">${money(monthCost(r))}</td>` : ""}
	</tr>`;
	const table = (rows: UsageRow[], month: boolean) =>
		rows.length
			? `<div class="scroll"><table><thead>${head}${month ? '<th class="num">Após franquia</th>' : ""}</tr></thead><tbody>${rows.map((r) => row(r, month)).join("")}</tbody></table></div>`
			: '<p class="empty">Nenhum lote registrado nesse período.</p>';
	const current = months[0];
	return `<section id="testes">
		<h4>Tests em Dynamic Workers${current ? `, mês ${esc(current.period)}` : ""}</h4>
		${
			current
				? `${statList([...mainStats(current), ["Após franquia", money(monthCost(current))]])}
					<details class="plain"><summary>Mais números do mês</summary>${statList([["Execuções", n(current.runs)], ...detailStats(current)])}</details>`
				: '<p class="empty">Nenhum lote registrado.</p>'
		}
		<details class="plain"><summary>Por dia (últimos 30 dias, UTC)</summary>${table(days, false)}</details>
		<details class="plain"><summary>Por mês</summary>${table(months, true)}</details>
		${how(
			"Como estimamos",
			`Cada lote do check Tests (um grupo de arquivos de teste que a fila entrega a um Dynamic Worker) registra os Dynamic Workers que criou e o CPU que usaram. O custo soma Dynamic Workers (${price(PRICES.dynamicWorker)} cada), CPU (${price(PRICES.cpuMs * 1_000_000)} por milhão de ms), requisições e operações de fila, a preço de tabela. “Após franquia” desconta a franquia mensal (${n(INCLUDED.dynamicWorkers)} Dynamic Workers e ${n(INCLUDED.cpuMs / 1_000_000)} milhões de ms de CPU) como se só estes testes a usassem; na conta ela é dividida com os outros Workers. Não entra o CPU do Worker da fila, que monta o código dos lotes. Quando um Dynamic Worker cai, em geral por falta de memória, o lote é dividido em lotes menores e roda de novo.`,
		)}
	</section>`;
}

/** Estimates for the Container tests check, from what each run's container recorded. */
function renderContainers(days: ContainerRow[], months: ContainerRow[]): string {
	const row = (r: ContainerRow, month: boolean) => `<tr>
		<td class="mono">${esc(r.period)}</td>
		<td class="num">${n(r.runs)}</td>
		<td class="num">${cpu(r.wallMs)}</td>
		<td class="num${r.unmeasured ? " failure" : ""}" ${r.unmeasured ? `title="${r.unmeasured} sem CPU medida"` : ""}>${cpu(Math.round(r.cpuUs / 1000))}</td>
		<td class="num">${money(boxesCost(r))}</td>
		${month ? `<td class="num">${money(containerOverage(containerRuns(r)))}</td>` : ""}
	</tr>`;
	const table = (rows: ContainerRow[], month: boolean) =>
		rows.length
			? `<div class="scroll"><table><thead><tr><th>Período</th><th class="num">Execuções</th><th class="num">Tempo ligado</th><th class="num">CPU usada</th><th class="num">Custo</th>${month ? '<th class="num">Após franquia</th>' : ""}</tr></thead><tbody>${rows.map((r) => row(r, month)).join("")}</tbody></table></div>`
			: '<p class="empty">Nenhum container registrado nesse período.</p>';
	const current = months[0];
	const stats: Stat[] = current
		? [
				["Custo estimado", money(boxesCost(current))],
				["Após franquia", money(containerOverage(containerRuns(current)))],
				["Execuções", n(current.runs)],
				["Tempo ligado", cpu(current.wallMs)],
			]
		: [];
	return `<section id="containers">
		<h4>Container tests${current ? `, mês ${esc(current.period)}` : ""}</h4>
		${current ? `${statList(stats)}${renderAllowances(containerAllowances(containerRuns(current)))}` : '<p class="empty">Nenhum container registrado.</p>'}
		<details class="plain"><summary>Por dia (últimos 30 dias, UTC)</summary>${table(days, false)}</details>
		<details class="plain"><summary>Por mês</summary>${table(months, true)}</details>
		${how(
			"Como estimamos",
			`Cada execução sobe um container ${esc(INSTANCE.name)} (${INSTANCE.vcpu} vCPU, ${INSTANCE.memoryGiB} GiB, ${INSTANCE.diskGB} GB). Memória (${price(CONTAINER_PRICES.memoryGiBs)} por GiB-s) e disco (${price(CONTAINER_PRICES.diskGBs)} por GB-s) contam pelo tempo ligado; CPU (${price(CONTAINER_PRICES.vcpuS)} por vCPU-s) pelo que foi usado. A franquia mensal inclui ${hours(CONTAINER_INCLUDED.memoryGiBs)} GiB-h de memória, ${n(CONTAINER_INCLUDED.vcpuS / 60)} vCPU-min e ${hours(CONTAINER_INCLUDED.diskGBs)} GB-h de disco, como se só estes testes a usassem.`,
		)}
	</section>`;
}

export function renderCostsPage({ days, months, repos, repo, account, containerDays = [], containerMonths = [], email }: CostsPageData): string {
	const filters = `<form class="filters" method="get" action="/admin/costs#estimativas">
		${select("repo", "Repositório", repo ?? "", [["", "Todos os repositórios"], ...repos.map((r): [string, string] => [r, r])])}
		<button type="submit" class="secondary">Aplicar</button>
		${repo ? '<a href="/admin/costs#estimativas">Limpar</a>' : ""}
	</form>`;
	const index = [
		...(account === undefined ? [] : [["conta", "Uso medido da conta"]]),
		["testes", "Estimativa: Tests"],
		["containers", "Estimativa: Container tests"],
	];
	return layout(
		"Custos",
		`${renderHeader(email, "costs")}
		<main class="costs">
			<h2>Custos</h2>
			${renderLead(account, months[0], containerMonths[0], repo)}
			<nav class="toc" aria-label="Nesta página">${index.map(([id, text]) => `<a href="#${id}">${text}</a>`).join("")}</nav>
			${renderAccount(account)}
			<section id="estimativas">
				<h3>Estimativas por repositório</h3>
				<p class="hint">Calculadas a partir do que cada execução de teste registra. O filtro vale só para as estimativas; o uso medido acima é da conta inteira.</p>
				${filters}
				${renderTests(days, months)}
				${renderContainers(containerDays, containerMonths)}
			</section>
		</main>`,
	);
}
