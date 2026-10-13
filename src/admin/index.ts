import { checks as allChecks } from "../checks/index.ts";
import type { Check } from "../checks/types.ts";
import { GitHubClient, type InstalledRepo } from "../github.ts";
import { getRepoSettings, setChecksEnabled, setRepoEnabled } from "../settings.ts";
import { hub } from "../live.ts";
import { d1RunStore, type RunStore } from "../runs.ts";
import { LIVE_SCRIPT } from "./live-script.ts";
import { renderAdminPage, renderMessage, repoQuery, repoSearch } from "./page.ts";
import { renderRunPage, renderRunsPage, runQuery } from "./runs-page.ts";

export const ADMIN_PATH = "/admin";

export interface AdminDeps {
	checks?: Check[];
	listRepos?: (env: Env) => Promise<InstalledRepo[]>;
	runs?: (env: Env) => RunStore;
	now?: () => number;
}

const listInstalledRepos = (env: Env) =>
	GitHubClient.listInstalledRepos({ appId: env.GITHUB_APP_ID, privateKey: env.GITHUB_PRIVATE_KEY });

/**
 * The admin UI, served under /admin. Cloudflare Access signs people in in front of
 * the Worker; requests Access did not authenticate for this application are refused.
 */
export async function handleAdmin(
	request: Request,
	env: Env,
	access: CloudflareAccessContext | undefined,
	{ checks = allChecks, listRepos = listInstalledRepos, runs = (e) => d1RunStore(e.RUNS), now = Date.now }: AdminDeps = {},
): Promise<Response> {
	if (!access || access.aud !== env.ACCESS_AUD) {
		return html(renderMessage("Acesso negado", "Entre pelo Cloudflare Access para usar o admin."), 403);
	}
	const url = new URL(request.url);
	const path = url.pathname.replace(/\/+$/, "") || "/";

	if (request.method === "GET" && path === ADMIN_PATH) {
		const repos = await listRepos(env);
		const rows = await Promise.all(
			repos.map(async (repo) => ({ repo, settings: await getRepoSettings(env.SETTINGS, repo.full_name) })),
		);
		const identity = await access.getIdentity();
		return html(renderAdminPage({ email: identity?.email, checks, rows, open: url.searchParams.get("open"), query: repoQuery(url.searchParams) }));
	}

	if (request.method === "GET" && path === `${ADMIN_PATH}/live.js`) {
		return new Response(LIVE_SCRIPT, { headers: { "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "no-cache" } });
	}

	if (request.method === "GET" && path === `${ADMIN_PATH}/live`) {
		if (request.headers.get("Upgrade") !== "websocket") return html(renderMessage("Esperava um WebSocket", ""), 426);
		// The browser sends Origin on WebSocket handshakes; refuse other sites.
		if (request.headers.get("Origin") !== url.origin) return html(renderMessage("Origem inválida", ""), 403);
		return hub(env.LIVE).fetch(request);
	}

	if (request.method === "GET" && path === `${ADMIN_PATH}/runs`) {
		const identity = await access.getIdentity();
		const store = runs(env);
		const query = runQuery(url.searchParams);
		const [list, repos] = await Promise.all([store.list(query), store.repos()]);
		return html(renderRunsPage({ runs: list, repos, query, email: identity?.email, now: now() }));
	}

	const runMatch = request.method === "GET" ? new RegExp(`^${ADMIN_PATH}/runs/(\\d+)$`).exec(path) : null;
	if (runMatch) {
		const run = await runs(env).get(Number(runMatch[1]));
		if (!run) return html(renderMessage("Execução não encontrada", ""), 404);
		const identity = await access.getIdentity();
		return html(renderRunPage(run, identity?.email, now()));
	}

	if (request.method === "POST" && path.startsWith(`${ADMIN_PATH}/`)) {
		// Forms post from the admin page itself; anything else is a cross-site request.
		if (request.headers.get("Origin") !== url.origin) return html(renderMessage("Origem inválida", ""), 403);
		const form = await request.formData();
		const enabled = form.get("enabled") === "true";
		const repo = (await listRepos(env)).find((r) => r.full_name === form.get("repo"))?.full_name;
		if (!repo) return invalid();

		switch (path) {
			case `${ADMIN_PATH}/repos`:
				await setRepoEnabled(env.SETTINGS, repo, enabled);
				break;
			case `${ADMIN_PATH}/checks`: {
				const check = checks.find((c) => c.id === form.get("check"));
				if (!check) return invalid();
				await setChecksEnabled(env.SETTINGS, repo, [check.id], enabled);
				break;
			}
			case `${ADMIN_PATH}/checks/all`:
				await setChecksEnabled(env.SETTINGS, repo, checks.map((c) => c.id), enabled);
				break;
			default:
				return html(renderMessage("Página não encontrada", ""), 404);
		}
		// Return to the same filtered view. Changes to checks happen inside the repository's
		// collapsible, so keep it open.
		const back = repoQuery(new URLSearchParams(String(form.get("back") ?? "")));
		const search = repoSearch(back, path === `${ADMIN_PATH}/repos` ? {} : { open: repo });
		return Response.redirect(`${url.origin}${ADMIN_PATH}${search}#${encodeURIComponent(repo)}`, 303);
	}

	return html(renderMessage("Página não encontrada", ""), 404);
}

const invalid = () => html(renderMessage("Pedido inválido", "Repositório ou check desconhecido."), 400);

function html(body: string, status = 200): Response {
	return new Response(body, {
		status,
		headers: {
			"Content-Type": "text/html; charset=utf-8",
			"Cache-Control": "no-store",
			"Content-Security-Policy":
				"default-src 'none'; script-src 'self'; connect-src 'self'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'",
		},
	});
}
