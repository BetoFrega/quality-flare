import { checks as allChecks } from "../checks/index.ts";
import type { Check } from "../checks/types.ts";
import { GitHubClient, type InstalledRepo } from "../github.ts";
import { getDisabledChecks, setCheckEnabled } from "../settings.ts";
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
			repos.map(async (repo) => ({ repo, disabled: await getDisabledChecks(env.SETTINGS, repo.full_name) })),
		);
		const identity = await access.getIdentity();
		return html(renderAdminPage({ email: identity?.email, checks, rows }));
	}

	if (request.method === "POST" && path === `${ADMIN_PATH}/checks`) {
		// Forms post from the admin page itself; anything else is a cross-site request.
		if (request.headers.get("Origin") !== url.origin) return html(renderMessage("Origem inválida", ""), 403);
		const form = await request.formData();
		const repo = String(form.get("repo") ?? "");
		const checkId = String(form.get("check") ?? "");
		const enabled = form.get("enabled") === "true";
		const check = checks.find((c) => c.id === checkId);
		const installed = (await listRepos(env)).find((r) => r.full_name === repo);
		if (!check || !installed) return html(renderMessage("Pedido inválido", "Repositório ou check desconhecido."), 400);
		await setCheckEnabled(env.SETTINGS, installed.full_name, check.id, enabled);
		return Response.redirect(`${url.origin}${ADMIN_PATH}#${encodeURIComponent(installed.full_name)}`, 303);
	}

	return html(renderMessage("Página não encontrada", ""), 404);
}

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
