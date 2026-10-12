import { checks as allChecks } from "../checks/index.ts";
import type { Check } from "../checks/types.ts";
import { GitHubClient, type InstalledRepo } from "../github.ts";
import { getRepoSettings, setChecksEnabled, setRepoEnabled } from "../settings.ts";
import { renderAdminPage, renderMessage } from "./page.ts";

export const ADMIN_PATH = "/admin";

export interface AdminDeps {
	checks?: Check[];
	listRepos?: (env: Env) => Promise<InstalledRepo[]>;
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
	{ checks = allChecks, listRepos = listInstalledRepos }: AdminDeps = {},
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
		return html(renderAdminPage({ email: identity?.email, checks, rows, open: url.searchParams.get("open") }));
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
		// Changes to checks happen inside the repository's collapsible, so keep it open.
		const open = path === `${ADMIN_PATH}/repos` ? "" : `?open=${encodeURIComponent(repo)}`;
		return Response.redirect(`${url.origin}${ADMIN_PATH}${open}#${encodeURIComponent(repo)}`, 303);
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
			"Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'",
		},
	});
}
