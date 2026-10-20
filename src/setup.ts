import { esc, layout, renderMessage, TESTS_OFF_NOTE } from "./admin/page.ts";
import { testsOff } from "./checks/index.ts";

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
	if (request.method !== "GET") return html(renderMessage("Method not allowed", ""), 405);
	const url = new URL(request.url);
	const path = url.pathname.replace(/\/+$/, "");

	if (path === SETUP_PATH) return html(renderStatus(env, url.origin));

	// Only a Worker without an App creates one, so a finished installation has nothing here to abuse.
	if (path === `${SETUP_PATH}/github` || path === `${SETUP_PATH}/github/callback`) {
		if (appConfigured(env)) return Response.redirect(`${url.origin}${SETUP_PATH}`, 303);
	}

	if (path === `${SETUP_PATH}/github`) {
		const org = url.searchParams.get("org")?.trim() ?? "";
		if (org && !/^[A-Za-z0-9-]{1,39}$/.test(org)) return html(renderMessage("Invalid organization", org), 400);
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
			return html(renderMessage("Link expired", `Start again at ${SETUP_PATH}.`), 400);
		}
		const res = await fetchFn(`https://api.github.com/app-manifests/${code}/conversions`, {
			method: "POST",
			headers: { Accept: "application/vnd.github+json", "User-Agent": "quality-flare", "X-GitHub-Api-Version": "2022-11-28" },
		});
		if (!res.ok) return html(renderMessage("GitHub refused the code", `${res.status} ${await res.text()}`), 502);
		const app = (await res.json()) as CreatedApp;
		return html(renderCreated(app), 200, { "Set-Cookie": `${STATE_COOKIE}=; Path=${SETUP_PATH}; Max-Age=0; HttpOnly; Secure; SameSite=Lax` });
	}

	return html(renderMessage("Page not found", ""), 404);
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
				? `<p>Set up (App ID ${esc(env.GITHUB_APP_ID)}).</p>`
				: `<p>Creates the App on GitHub with the permissions and events the checks use, with its webhook pointing to this address.</p>
				<form method="get" action="${SETUP_PATH}/github">
					<label>Organization (empty for your account) <input name="org" placeholder="my-org" pattern="[A-Za-z0-9-]{1,39}"></label>
					<button type="submit">Create the GitHub App</button>
				</form>`,
		),
		step(
			Boolean(env.PUBLIC_URL),
			"Public address",
			env.PUBLIC_URL
				? `<p><code>PUBLIC_URL</code> = <code>${esc(env.PUBLIC_URL)}</code>.</p>`
				: `<p>Add the build variable <code>PUBLIC_URL</code> = <code>${esc(origin)}</code> (or your own domain) in the Worker's <a href="${DASHBOARD}">Settings → Build → Variables and secrets</a>. Check runs link to the admin at this address.</p>`,
		),
		step(
			Boolean(env.ACCESS_AUD),
			"Admin sign-in (Cloudflare Access)",
			env.ACCESS_AUD
				? `<p>The admin is at <a href="/admin">/admin</a>.</p>`
				: `<p>In <a href="${ZERO_TRUST}">Zero Trust</a>, under Access → Applications, create a <em>Self-hosted</em> application for <code>${esc(new URL(origin).host)}</code> with the paths <code>admin</code> and <code>admin/*</code> and a policy that allows your email. Copy the <em>Application Audience (AUD) Tag</em> into the build variable <code>ACCESS_AUD</code>.</p>`,
		),
	];
	// Not a step: the other checks work without Workers Paid, and the deploy turns the tests on once the account has it.
	if (testsOff(env)) steps.push(`<li><h3>ℹ️ Tests</h3><p>${TESTS_OFF_NOTE}</p></li>`);
	const done = !setupPending(env);
	return layout(
		"Setup",
		`<main>
			<h2>quality-flare setup</h2>
			<p class="hint">${done ? "All set. Install the App on your repositories and enable them in the admin." : "After you change build variables or secrets, run the build again (Deployments → Retry build, or a push to main) to deploy with them."}</p>
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
		"Create the GitHub App",
		`<main>
			<h2>Creating the GitHub App…</h2>
			<form id="manifest" method="post" action="${esc(action)}">
				<input type="hidden" name="manifest" value="${esc(JSON.stringify(app))}">
				<button type="submit">Continue on GitHub</button>
			</form>
			<script>document.getElementById("manifest").submit();</script>
		</main>`,
	);
}

function renderCreated(app: CreatedApp): string {
	const secret = (name: string, value: string, rows = 1) =>
		`<label><code>${name}</code><textarea readonly rows="${rows}">${esc(value)}</textarea></label>`;
	return layout(
		"GitHub App created",
		`<main>
			<h2>GitHub App <a href="${esc(app.html_url)}">${esc(app.slug)}</a> created</h2>
			<p class="hint">These values show only now: quality-flare does not store them. If you lose this page, generate a new key and a new webhook secret in the App's settings.</p>
			<ol class="setup">
				<li><h3>1. Save the secrets</h3>
					<p>In the Worker's <a href="${DASHBOARD}">Settings → Build → Variables and secrets</a>, add each one as a <em>Secret</em>:</p>
					${secret("GITHUB_APP_ID", String(app.id))}
					${secret("GITHUB_WEBHOOK_SECRET", app.webhook_secret)}
					${secret("GITHUB_PRIVATE_KEY", app.pem, 8)}
				</li>
				<li><h3>2. Deploy again</h3><p>Deployments → Retry build (or a push to main). The deploy passes the secrets to the Worker.</p></li>
				<li><h3>3. Install the App</h3><p><a href="${esc(app.html_url)}/installations/new">Choose the repositories</a>, then enable them in the admin.</p></li>
			</ol>
			<p><a href="${SETUP_PATH}">Back to setup</a></p>
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
