import { dayCost, monthOverage, type AccountUsage } from "../account-usage.ts";
import { cost, INCLUDED, LOST_AFTER_MS, monthCost, PRICES, type AttemptRow, type ShardOutcome, type Usage, type UsageRow } from "../metrics.ts";
import { esc, layout, renderHeader, select } from "./page.ts";

/** Usage and estimated cost: the run pages' "Uso" section and the /admin/costs page. */

export function money(usd: number): string {
	return usd === 0 ? "US$ 0" : usd < 0.01 ? `US$ ${usd.toFixed(4)}` : `US$ ${usd.toFixed(2)}`;
}

export function cpu(ms: number): string {
	return ms < 1000 ? `${ms} ms` : ms < 60_000 ? `${(ms / 1000).toFixed(1)} s` : ms < 1_000_000 ? `${(ms / 60_000).toFixed(1)} min` : `${(ms / 1_000_000).toFixed(1)} mi ms`;
}

const n = (value: number) => value.toLocaleString("pt-BR");

/** Cells for a run in the runs list: Dynamic Workers and estimated cost. */
export function usageCells(u: Usage | undefined): string {
	if (!u) return '<td class="num">—</td><td class="num">—</td>';
	const trouble = u.crashes ? ` <span class="failure" title="quedas">${u.crashes}✗</span>` : "";
	return `<td class="num">${n(u.dynamicWorkers)}${trouble}</td><td class="num">${money(cost(u))}</td>`;
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

function stats(u: Usage, extra: [string, string][] = []): string {
	const items: [string, string][] = [
		["Custo estimado", money(cost(u))],
		["Dynamic Workers", n(u.dynamicWorkers)],
		["CPU dos Dynamic Workers", cpu(u.cpuMs)],
		["Lotes (entregas da fila)", n(u.attempts)],
		["Tempo somado dos lotes", cpu(u.wallMs)],
		["Retries", n(u.retries)],
		["Quedas (memória)", n(u.crashes)],
		["Divisões", n(u.splits)],
		...extra,
	];
	return `<dl class="stats">${items.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join("")}</dl>`;
}

/** The run page's usage section: totals and every shard attempt. In a run that is over, an attempt that never ended crashed. */
export function renderRunUsage(u: Usage | undefined, attempts: AttemptRow[], now: number, over: boolean): string {
	if (!u || !attempts.length) return "";
	const rows = attempts
		.map((a) => {
			const lost = !a.outcome && (over || (a.startedAt ?? now) < now - LOST_AFTER_MS);
			const outcome = a.outcome ? OUTCOME[a.outcome] : lost ? "Caiu (consumer sem memória?)" : "Rodando";
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
		${stats(u)}
		<p class="hint">Estimativa sem a franquia mensal. Não inclui o CPU do consumer da fila, que monta o código dos lotes.</p>
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
	email?: string;
}

/** What Cloudflare measured on the whole account: the numbers it bills, without per-run detail. */
function renderAccount(account: AccountUsage | string | undefined): string {
	if (account === undefined) return "";
	if (typeof account === "string") return `<h3>Conta Cloudflare</h3><p class="hint failure">Não deu para ler o uso real da conta: ${esc(account)}</p>`;
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
			<td class="num">${money(dayCost(d))}</td>
		</tr>`,
		)
		.join("");
	const items: [string, string][] = [
		["Cobrança estimada do mês", money(monthOverage(month))],
		["Dynamic Workers", `${n(month.dynamicWorkers)} de ${n(INCLUDED.dynamicWorkers)}`],
		["CPU da conta", `${cpu(month.accountCpuMs)} de ${cpu(INCLUDED.cpuMs)}`],
		["CPU do quality-flare", cpu(month.cpuMs)],
		["Invocações com erro", n(month.errors)],
	];
	return `<h3>Conta Cloudflare, mês ${esc(month.period)} (medido)</h3>
		<dl class="stats">${items.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join("")}</dl>
		<p class="hint">Números reais do Cloudflare Analytics para a conta inteira, sem separar por execução. A cobrança estimada é o que passa da franquia do mês (mês do calendário, UTC; o ciclo de cobrança pode ser outro). Requisições e fila ficam dentro da franquia.</p>
		${
			days.length
				? `<details class="plain"><summary>Por dia (últimos 30 dias)</summary><div class="scroll"><table><thead><tr><th>Dia</th><th class="num">Dynamic Workers</th><th class="num">CPU do quality-flare</th><th class="num">Invocações</th><th class="num">Erros</th><th class="num">CPU da conta</th><th class="num">Custo bruto</th></tr></thead><tbody>${rows}</tbody></table></div></details>`
				: ""
		}`;
}

export function renderCostsPage({ days, months, repos, repo, account, email }: CostsPageData): string {
	const head = '<tr><th>Período</th><th class="num">Execuções</th><th class="num">Lotes</th><th class="num">Retries</th><th class="num">Quedas</th><th class="num">Dynamic Workers</th><th class="num">CPU dos DW</th><th class="num">Custo</th>';
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
	const filters = `<form class="filters" method="get" action="/admin/costs">
		${select("repo", "Repositório", repo ?? "", [["", "Todos os repositórios"], ...repos.map((r): [string, string] => [r, r])])}
		<button type="submit" class="secondary">Aplicar</button>
		${repo ? '<a href="/admin/costs">Limpar</a>' : ""}
	</form>`;
	return layout(
		"Custos",
		`${renderHeader(email, "costs")}
		<main>
			<h2>Custos</h2>
			${renderAccount(account)}
			<h3>Estimativa por execução dos testes</h3>
			<p class="hint">Estimados a partir do que cada lote do check Tests registra: Dynamic Workers criados (US$ ${PRICES.dynamicWorker} cada), CPU dos Dynamic Workers (US$ 0,02 por milhão de ms), requisições e operações de fila. O CPU do consumer da fila não entra. A conta inclui por mês ${n(INCLUDED.dynamicWorkers)} Dynamic Workers e ${n(INCLUDED.cpuMs / 1_000_000)} milhões de ms de CPU, divididos com os outros Workers. O valor cobrado de verdade está em <a href="https://dash.cloudflare.com/?to=/:account/billing">Billing &gt; Billable Usage</a>.</p>
			${filters}
			${current ? `<h3>Testes, mês ${esc(current.period)}</h3>${stats(current, [["Após franquia", money(monthCost(current))]])}` : ""}
			<h3>Testes por dia (últimos 30 dias, UTC)</h3>
			${table(days, false)}
			<h3>Testes por mês</h3>
			${table(months, true)}
		</main>`,
	);
}
