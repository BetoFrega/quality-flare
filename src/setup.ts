import { esc, layout, renderMessage } from "./admin/page.ts";

/**
 * The setup page of a new installation, served under /setup without sign-in: it says which of the Worker's
 * settings are still missing and creates the GitHub App from a manifest
 * (https://docs.github.com/apps/sharing-github-apps/registering-a-github-app-from-a-manifest).
 *
 * The page shows no secret of this Worker. The App's credentials appear once, on the page GitHub sends its
 * creator back to, and only while this Worker has no App yet; nothing is stored, so someone else creating an
 * App from here gets their own App's credentials and changes nothing on this Worker.
 */

export const SETUP_PATH = "/setup";

/** The value scripts/deploy.mjs gives the App's secrets on a new Worker's first deploy, before the App exists. */
export const PENDING = "setup-pending";

const STATE_COOKIE = "qf_setup_state";
const DASHBOARD = "https://dash.cloudflare.com/?to=/:account/workers/services/view/quality-flare/production/settings";
const ZERO_TRUST = "https://one.dash.cloudflare.com/";

/** The webhook events the checks listen to (src/index.ts). */
const EVENTS = [
	"pull_request",
	"pull_request_review",
	"pull_request_review_comment",
	"pull_request_review_thread",
	"issue_comment",
	"check_run",
	"check_suite",
];

const PERMISSIONS = {
	checks: "write",
	// The Tests checks download the PR's code; Dependabot auto-merge merges.
	contents: "write",
	// Dependabot auto-merge, and the status comment on PRs.
	pull_requests: "write",
	// Closes an issue reads the issues a PR closes; the daily full run opens one when it fails.
	issues: "write",
	metadata: "read",
};

/** Whether the GitHub App's secrets are set (not missing, nor the first deploy's placeholders). */
export function appConfigured(env: Env): boolean {
	return [env.GITHUB_APP_ID, env.GITHUB_PRIVATE_KEY, env.GITHUB_WEBHOOK_SECRET].every((v) => Boolean(v) && v !== PENDING);
}

/** Whether anything /setup lists as required is missing. */
export function setupPending(env: Env): boolean {
	return !appConfigured(env) || !env.PUBLIC_URL || !env.ACCESS_AUD;
}

export interface SetupDeps {
	fetch?: typeof fetch;
	random?: () => string;
}

export async function handleSetup(request: Request, env: Env, { fetch: fetchFn = fetch, random = randomState }: SetupDeps = {}): Promise<Response> {
	if (request.method !== "GET") return html(renderMessage("Método não permitido", ""), 405);
	const url = new URL(request.url);
	const path = url.pathname.replace(/\/+$/, "");

	if (path === SETUP_PATH) return html(renderStatus(env, url.origin));

	// Only a Worker without an App creates one, so a finished installation has nothing here to abuse.
	if (path === `${SETUP_PATH}/github` || path === `${SETUP_PATH}/github/callback`) {
		if (appConfigured(env)) return Response.redirect(`${url.origin}${SETUP_PATH}`, 303);
	}

	if (path === `${SETUP_PATH}/github`) {
		const org = url.searchParams.get("org")?.trim() ?? "";
		if (org && !/^[A-Za-z0-9-]{1,39}$/.test(org)) return html(renderMessage("Organização inválida", org), 400);
		const state = random();
		const target = org ? `https://github.com/organizations/${org}/settings/apps/new` : "https://github.com/settings/apps/new";
		return html(renderManifestForm(`${target}?state=${state}`, manifest(url)), 200, {
			"Set-Cookie": `${STATE_COOKIE}=${state}; Path=${SETUP_PATH}; Max-Age=3600; HttpOnly; Secure; SameSite=Lax`,
		});
	}

	if (path === `${SETUP_PATH}/github/callback`) {
		const code = url.searchParams.get("code");
		const state = url.searchParams.get("state");
		if (!code || !/^[A-Za-z0-9_-]+$/.test(code) || !state || cookie(request, STATE_COOKIE) !== state) {
			return html(renderMessage("Link expirado", `Comece de novo em ${SETUP_PATH}.`), 400);
		}
		const res = await fetchFn(`https://api.github.com/app-manifests/${code}/conversions`, {
			method: "POST",
			headers: { Accept: "application/vnd.github+json", "User-Agent": "quality-flare", "X-GitHub-Api-Version": "2022-11-28" },
		});
		if (!res.ok) return html(renderMessage("O GitHub recusou o código", `${res.status} ${await res.text()}`), 502);
		const app = (await res.json()) as CreatedApp;
		return html(renderCreated(app), 200, { "Set-Cookie": `${STATE_COOKIE}=; Path=${SETUP_PATH}; Max-Age=0; HttpOnly; Secure; SameSite=Lax` });
	}

	return html(renderMessage("Página não encontrada", ""), 404);
}

interface CreatedApp {
	id: number;
	slug: string;
	html_url: string;
	pem: string;
	webhook_secret: string;
}

/** The App this Worker's address asks GitHub to create. */
export function manifest(url: URL): object {
	return {
		name: appName(url.hostname),
		url: url.origin,
		hook_attributes: { url: `${url.origin}/`, active: true },
		redirect_url: `${url.origin}${SETUP_PATH}/github/callback`,
		public: false,
		default_permissions: PERMISSIONS,
		default_events: EVENTS,
	};
}

/** App names are unique on GitHub and at most 34 characters; GitHub lets its creator change it. */
function appName(hostname: string): string {
	const [first, second] = hostname.split(".");
	const label = hostname.endsWith(".workers.dev") ? second : first;
	return `quality-flare-${label}`.slice(0, 34).replace(/-+$/, "");
}

function renderStatus(env: Env, origin: string): string {
	const app = appConfigured(env);
	const steps = [
		step(
			app,
			"GitHub App",
			app
				? `<p>Configurada (App ID ${esc(env.GITHUB_APP_ID)}).</p>`
				: `<p>Cria a App no GitHub com as permissões e eventos que os checks usam, apontando o webhook para este endereço.</p>
				<form method="get" action="${SETUP_PATH}/github">
					<label>Organização (vazio para a sua conta) <input name="org" placeholder="minha-org" pattern="[A-Za-z0-9-]{1,39}"></label>
					<button type="submit">Criar a GitHub App</button>
				</form>`,
		),
		step(
			Boolean(env.PUBLIC_URL),
			"Endereço público",
			env.PUBLIC_URL
				? `<p><code>PUBLIC_URL</code> = <code>${esc(env.PUBLIC_URL)}</code>.</p>`
				: `<p>Adicione a variável de build <code>PUBLIC_URL</code> = <code>${esc(origin)}</code> (ou o seu domínio) em <a href="${DASHBOARD}">Settings → Build → Variables and secrets</a> do Worker. Os check runs linkam para o admin nele.</p>`,
		),
		step(
			Boolean(env.ACCESS_AUD),
			"Login do admin (Cloudflare Access)",
			env.ACCESS_AUD
				? `<p>O admin está em <a href="/admin">/admin</a>.</p>`
				: `<p>No <a href="${ZERO_TRUST}">Zero Trust</a>, em Access → Applications, crie uma aplicação <em>Self-hosted</em> para <code>${esc(new URL(origin).host)}</code> com os caminhos <code>admin</code> e <code>admin/*</code> e uma política que permita o seu e-mail. Copie o <em>Application Audience (AUD) Tag</em> para a variável de build <code>ACCESS_AUD</code>.</p>`,
		),
	];
	const done = !setupPending(env);
	return layout(
		"Instalação",
		`<main>
			<h2>Instalação do quality-flare</h2>
			<p class="hint">${done ? "Tudo pronto. Instale a App nos repositórios e ative-os no admin." : "Depois de mudar variáveis ou secrets de build, rode o build de novo (Deployments → Retry build, ou um push na main) para publicar com eles."}</p>
			<ol class="setup">${steps.join("")}</ol>
		</main>`,
		`<style>.setup { list-style: none; padding: 0; } .setup li { border-top: 1px solid var(--line); padding: 12px 0; } .setup h3 { margin: 0 0 4px; } .setup label { display: flex; flex-direction: column; gap: 2px; color: var(--muted); font-size: 13px; margin: 8px 0; } .setup input { font: inherit; padding: 4px 8px; max-width: 280px; } .setup textarea { width: 100%; font: 12px ui-monospace, monospace; } code { overflow-wrap: anywhere; }</style>`,
	);
}

function step(ok: boolean, title: string, body: string): string {
	return `<li><h3>${ok ? "✅" : "⬜"} ${esc(title)}</h3>${body}</li>`;
}

/** Sends the manifest to GitHub: a form that submits itself, with a button if scripts are off. */
function renderManifestForm(action: string, app: object): string {
	return layout(
		"Criar a GitHub App",
		`<main>
			<h2>Criando a GitHub App…</h2>
			<form id="manifest" method="post" action="${esc(action)}">
				<input type="hidden" name="manifest" value="${esc(JSON.stringify(app))}">
				<button type="submit">Continuar no GitHub</button>
			</form>
			<script>document.getElementById("manifest").submit();</script>
		</main>`,
	);
}

function renderCreated(app: CreatedApp): string {
	const secret = (name: string, value: string, rows = 1) =>
		`<label><code>${name}</code><textarea readonly rows="${rows}">${esc(value)}</textarea></label>`;
	return layout(
		"GitHub App criada",
		`<main>
			<h2>GitHub App <a href="${esc(app.html_url)}">${esc(app.slug)}</a> criada</h2>
			<p class="hint">Estes valores aparecem só agora: o quality-flare não os guarda. Se perder esta página, gere outra chave e outro webhook secret nas configurações da App.</p>
			<ol class="setup">
				<li><h3>1. Guarde os secrets</h3>
					<p>Em <a href="${DASHBOARD}">Settings → Build → Variables and secrets</a> do Worker, adicione cada um como <em>Secret</em>:</p>
					${secret("GITHUB_APP_ID", String(app.id))}
					${secret("GITHUB_WEBHOOK_SECRET", app.webhook_secret)}
					${secret("GITHUB_PRIVATE_KEY", app.pem, 8)}
				</li>
				<li><h3>2. Publique de novo</h3><p>Deployments → Retry build (ou um push na main). O deploy passa os secrets para o Worker.</p></li>
				<li><h3>3. Instale a App</h3><p><a href="${esc(app.html_url)}/installations/new">Escolha os repositórios</a>; depois ative-os no admin.</p></li>
			</ol>
			<p><a href="${SETUP_PATH}">Voltar para a instalação</a></p>
		</main>`,
		`<style>.setup { list-style: none; padding: 0; } .setup li { border-top: 1px solid var(--line); padding: 12px 0; } .setup h3 { margin: 0 0 4px; } .setup label { display: flex; flex-direction: column; gap: 2px; margin: 8px 0; } .setup textarea { width: 100%; font: 12px ui-monospace, monospace; }</style>`,
	);
}

function cookie(request: Request, name: string): string | undefined {
	for (const part of (request.headers.get("Cookie") ?? "").split(";")) {
		const [key, ...value] = part.trim().split("=");
		if (key === name) return value.join("=");
	}
	return undefined;
}

function randomState(): string {
	return [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function html(body: string, status = 200, headers: Record<string, string> = {}): Response {
	return new Response(body, {
		status,
		headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", ...headers },
	});
}
