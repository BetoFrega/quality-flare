import { adminChecksFor, testsOff } from "../checks/index.ts";
import type { Check } from "../checks/types.ts";
import { GitHubClient, type InstalledRepo } from "../github.ts";
import { getRepoSettings, setChecksEnabled, setOnDemand, setRepoEnabled } from "../settings.ts";
import { hub } from "../live.ts";
import { accountUsage, type AccountUsage } from "../account-usage.ts";
import { containerUsage } from "../checks/tests/container.ts";
import { d1MetricsStore, type ContainerUsage, type MetricsStore, type Usage } from "../metrics.ts";
import { d1RunStore, type RunStore } from "../runs.ts";
import { renderCostsPage } from "./costs-page.ts";
import { LIVE_SCRIPT } from "./live-script.ts";
import { controlId, renderAdminPage, renderMessage, repoQuery, repoSearch } from "./page.ts";
import { renderRunPage, renderRunsPage, runQuery } from "./runs-page.ts";
import { SETUP_PATH } from "../setup.ts";

export const ADMIN_PATH = "/admin";

export interface AdminDeps {
	checks?: Check[];
	listRepos?: (env: Env) => Promise<InstalledRepo[]>;
	runs?: (env: Env) => RunStore;
	metrics?: (env: Env) => MetricsStore;
	/** The account's real usage, from Cloudflare's analytics. */
	account?: (env: Env) => Promise<AccountUsage>;
	/** The App's page for installing it on more repositories. */
	installUrl?: (env: Env) => Promise<string>;
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
	{
		checks = adminChecksFor(env),
		listRepos = listInstalledRepos,
		runs = (e) => d1RunStore(e.RUNS),
		metrics = (e) => d1MetricsStore(e.RUNS),
		account = async (e) => {
			// Bound only when the deploy had SECRETS_STORE_ID and CLOUDFLARE_ACCOUNT_ID (cloudflare.config.ts).
			if (!e.ANALYTICS_TOKEN) throw new Error("No analytics token: set SECRETS_STORE_ID and CLOUDFLARE_ACCOUNT_ID in the build (see the README).");
			return accountUsage({ token: await e.ANALYTICS_TOKEN.get(), account: e.CLOUDFLARE_ACCOUNT_ID, script: "quality-flare" });
		},
		installUrl = (e) => GitHubClient.installUrl({ appId: e.GITHUB_APP_ID, privateKey: e.GITHUB_PRIVATE_KEY }),
		now = Date.now,
	}: AdminDeps = {},
): Promise<Response> {
	if (!env.ACCESS_AUD) {
		return html(renderMessage("Admin closed", `Cloudflare Access does not protect the admin yet. See ${SETUP_PATH} to set it up.`), 403);
	}
	if (!access || access.aud !== env.ACCESS_AUD) {
		return html(renderMessage("Access denied", "Sign in through Cloudflare Access to use the admin."), 403);
	}
	const url = new URL(request.url);
	const path = url.pathname.replace(/\/+$/, "") || "/";
	// Past this point the person is signed in: messages keep the admin's header and navigation.
	const message = async (status: number, title: string, detail = "", back = false) =>
		html(renderMessage(title, detail, { email: (await access.getIdentity())?.email, back }), status);
	const notFound = (title = "Page not found") => message(404, title, "", true);
	const invalid = () => message(400, "Invalid request", "Unknown repository or check.", true);

	if (request.method === "GET" && path === ADMIN_PATH) {
		const [repos, install] = await Promise.all([
			listRepos(env),
			installUrl(env).catch((error: unknown) => {
				console.error("quality-flare: could not read the App's link", error);
				return undefined;
			}),
		]);
		const rows = await Promise.all(
			repos.map(async (repo) => ({ repo, settings: await getRepoSettings(env.SETTINGS, repo.full_name) })),
		);
		const identity = await access.getIdentity();
		return html(renderAdminPage({ email: identity?.email, checks, rows, open: url.searchParams.get("open"), changed: url.searchParams.get("changed"), query: repoQuery(url.searchParams), installUrl: install, testsOff: testsOff(env) }));
	}

	if (request.method === "GET" && path === `${ADMIN_PATH}/live.js`) {
		return new Response(LIVE_SCRIPT, { headers: { "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "no-cache" } });
	}

	if (request.method === "GET" && path === `${ADMIN_PATH}/live`) {
		if (request.headers.get("Upgrade") !== "websocket") return message(426, "Expected a WebSocket");
		// The browser sends Origin on WebSocket handshakes; refuse other sites.
		if (request.headers.get("Origin") !== url.origin) return message(403, "Invalid origin");
		return hub(env.LIVE).fetch(request);
	}

	if (request.method === "GET" && path === `${ADMIN_PATH}/runs`) {
		const identity = await access.getIdentity();
		const store = runs(env);
		const query = runQuery(url.searchParams);
		const [list, repos] = await Promise.all([store.list(query), store.repos()]);
		// Usage is extra: the list still shows if it can't be read.
		const ids = list.map((r) => r.id);
		const usageStore = metrics(env);
		const [usage, containers] = await Promise.all([
			usageStore.byRun(ids).catch(logMetricsError(new Map<number, Usage>())),
			usageStore.containersByRun(ids).catch(logMetricsError(new Map<number, ContainerUsage>())),
		]);
		return html(renderRunsPage({ runs: list, repos, query, usage, containers, email: identity?.email, now: now() }));
	}

	const runMatch = request.method === "GET" ? new RegExp(`^${ADMIN_PATH}/runs/(\\d+)$`).exec(path) : null;
	if (runMatch) {
		const run = await runs(env).get(Number(runMatch[1]));
		if (!run) return notFound("Run not found");
		const identity = await access.getIdentity();
		const store = metrics(env);
		const [usage, attempts, container] = await Promise.all([
			store.byRun([run.id]).then((m) => m.get(run.id)).catch(logMetricsError(undefined)),
			store.attempts(run.id).catch(logMetricsError([])),
			containerUsage(env.RUNS, run.id).catch(logMetricsError(undefined)),
		]);
		return html(renderRunPage(run, identity?.email, now(), { usage, attempts, container }));
	}

	if (request.method === "GET" && path === `${ADMIN_PATH}/costs`) {
		const identity = await access.getIdentity();
		const at = now();
		const day = 86_400_000;
		const store = metrics(env);
		const repos = await runs(env).repos();
		const repo = repos.find((r) => r === url.searchParams.get("repo"));
		const monthStart = (back: number) => {
			const d = new Date(at);
			return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - back, 1);
		};
		const daysSince = Math.floor(at / day) * day - 29 * day;
		const [days, months, containerDays, containerMonths, real] = await Promise.all([
			store.usage("day", daysSince, repo).catch(logMetricsError([])),
			store.usage("month", monthStart(11), repo).catch(logMetricsError([])),
			store.containerUsage("day", daysSince, repo).catch(logMetricsError([])),
			store.containerUsage("month", monthStart(11), repo).catch(logMetricsError([])),
			account(env).catch((error: unknown) => {
				console.error("quality-flare: could not read the account's usage", error);
				return error instanceof Error ? error.message : String(error);
			}),
		]);
		return html(renderCostsPage({ days, months, repos, repo, account: real, containerDays, containerMonths, email: identity?.email }));
	}

	if (request.method === "POST" && path.startsWith(`${ADMIN_PATH}/`)) {
		// Forms post from the admin page itself; anything else is a cross-site request.
		if (request.headers.get("Origin") !== url.origin) return message(403, "Invalid origin");
		const form = await request.formData();
		const enabled = form.get("enabled") === "true";
		const repo = (await listRepos(env)).find((r) => r.full_name === form.get("repo"))?.full_name;
		if (!repo) return invalid();

		// The control the change was made through, which the page focuses and confirms.
		let control: string;
		switch (path) {
			case `${ADMIN_PATH}/repos`:
				await setRepoEnabled(env.SETTINGS, repo, enabled);
				control = "repo";
				break;
			case `${ADMIN_PATH}/checks`: {
				const check = checks.find((c) => c.id === form.get("check"));
				if (!check) return invalid();
				await setChecksEnabled(env.SETTINGS, repo, [check.id], enabled);
				control = `check:${check.id}`;
				break;
			}
			case `${ADMIN_PATH}/on-demand`:
				await setOnDemand(env.SETTINGS, repo, enabled);
				control = "on-demand";
				break;
			case `${ADMIN_PATH}/checks/all`:
				await setChecksEnabled(env.SETTINGS, repo, checks.map((c) => c.id), enabled);
				control = "checks";
				break;
			default:
				return notFound();
		}
		// Return to the same filtered view, with focus back on the control that was used. Changes
		// to checks happen inside the repository's collapsible, so keep it open.
		const back = repoQuery(new URLSearchParams(String(form.get("back") ?? "")));
		const id = controlId(repo, control);
		const search = repoSearch(back, { ...(path === `${ADMIN_PATH}/repos` ? {} : { open: repo }), changed: id });
		return Response.redirect(`${url.origin}${ADMIN_PATH}${search}#${encodeURIComponent(id)}`, 303);
	}

	return notFound();
}

function logMetricsError<T>(fallback: T): (error: unknown) => T {
	return (error) => {
		console.error("quality-flare: could not read test usage", error);
		return fallback;
	};
}

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
