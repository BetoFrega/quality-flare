import { esc } from "./admin/page.ts";
import { SETUP_PATH } from "./setup.ts";

/**
 * The public pages: what quality-flare is, at the root of the Worker, and its documentation under /docs,
 * rendered from docs/*.md at build time (build/docs.ts). Neither needs sign-in nor reads any setting
 * beyond whether /setup is finished.
 */

export const DOCS_PATH = "/docs";
/** The project's own instance, the only one whose root shows the home page; other installations' roots open their admin. */
export const OFFICIAL_URL = "https://quality-flare.frega.dev";
const REPO_URL = "https://github.com/BetoFrega/quality-flare";

type DocPage = { slug: string; section: string; title: string; html: string };

/** The documentation page at `pathname`, or a 404 page. */
export async function handleDocs(pathname: string): Promise<Response> {
	// Imported on first use, like virtual:test-runtime, so code that imports the Worker without serving docs
	// (the Tests check running this repository's own tests) doesn't need the build's virtual module.
	const { default: pages } = await import("virtual:docs");
	const slug = pathname.replace(/\/+$/, "").slice(DOCS_PATH.length + 1) || "index";
	const page = pages.find((p) => p.slug === slug);
	return html(renderDocsPage(pages, page), page ? 200 : 404);
}

/** The home page. `pending` adds a note that this installation's /setup isn't finished. */
export function handleHome(pending: boolean): Response {
	return html(renderHome(pending));
}

const CHECKS = [
	{ name: "Tests", link: "checks#tests", body: "Your vitest suite in Dynamic Workers created for each run, sharded through a Queue. Test files, the lockfile and tsconfig paths are found without config." },
	{ name: "Container tests", link: "checks#container-tests", body: "Your own vitest and config in a fresh container, then named commands such as Typecheck and Lint, each as its own check run with a live log." },
	{ name: "Closes an issue", link: "checks#closes-an-issue", body: "Passes when the pull request closes an issue, by keyword or sidebar link, or carries the no-issue label." },
	{ name: "Codex review", link: "checks#codex-review", body: "Holds the merge until every Codex review thread is resolved, and waits while Codex is still reviewing." },
	{ name: "Dependabot auto-merge", link: "checks#dependabot-auto-merge", body: "Turns on squash auto-merge for Dependabot pull requests, without a workflow." },
];

const FEATURES = [
	{ name: "Tests on demand", link: "on-demand", body: "Pushes don't spend a run. Comment <code>/quality-flare run</code> when the pull request is ready; one status comment tells agents and people where it stands." },
	{ name: "Only what changed", link: "running-tests#run-only-the-tests-a-change-affects", body: "Pull requests run the tests that depend on the change. A daily full run on the default branch catches the rest and opens an issue when it fails." },
	{ name: "Caches on R2", link: "running-tests#make-runs-faster", body: "Turborepo's remote cache, tool caches such as ESLint's and tsc's, and container snapshots that skip the install." },
	{ name: "Live progress", link: "checks#container-tests", body: "Check runs update every few seconds with counts and failures, and the admin streams each test as it finishes." },
	{ name: "Costs you can see", link: "admin#costs", body: "Measured account usage next to an estimate for every run, repository and day." },
	{ name: "Off until you say so", link: "admin", body: "Every repository and check starts disabled. Turn them on one by one in an admin behind Cloudflare Access." },
];

/** The steps of a pull request through quality-flare, with the Cloudflare product behind each. */
const FLOW = [
	{ step: "Webhook", body: "GitHub calls the Worker, which verifies the signature and answers at once.", product: "Workers" },
	{ step: "Checks", body: "Each enabled check opens a check run on the head commit.", product: "KV settings" },
	{ step: "Run", body: "Test batches go to Dynamic Workers through a Queue, or to a container per run.", product: "Queues · Dynamic Workers · Containers" },
	{ step: "Report", body: "Check runs, one status comment and live admin pages. History stays in D1.", product: "Durable Objects · D1" },
];

/** A pull request's checks box, as GitHub shows it, drawn with what quality-flare reports. */
function checksPanel(): string {
	const row = (state: "ok" | "wait", name: string, detail: string) =>
		`<li><span class="dot ${state}" aria-hidden="true"></span><span class="name">${esc(name)}</span><span class="detail">${esc(detail)}</span></li>`;
	return `<figure class="panel" aria-label="Example: the checks quality-flare reports on a pull request">
			<div class="panel-head"><span class="dot ok" aria-hidden="true"></span><strong>All checks have passed</strong><span class="muted">6 successful checks</span></div>
			<ul>
				${row("ok", "Tests", "3,063 passed in 214 files · 1m 48s")}
				${row("ok", "Container tests", "Affected tests passed · standard-4")}
				${row("ok", "Typecheck", "tsc --noEmit · 52s")}
				${row("ok", "Lint", "eslint, cached on R2 · 19s")}
				${row("ok", "Closes an issue", "Closes #128")}
				${row("ok", "Codex review", "Every suggestion resolved")}
			</ul>
			<div class="panel-comment"><span class="avatar" aria-hidden="true"></span><code>/quality-flare run</code><span class="reaction" aria-label="started">🚀</span></div>
		</figure>`;
}

function renderHome(pending: boolean): string {
	const docLink = (path: string) => `${DOCS_PATH}/${path}`;
	return layout(
		"quality-flare: CI on Cloudflare",
		"Continuous integration that runs entirely on Cloudflare, delivered as a GitHub App.",
		`${pending ? `<p class="banner">This installation isn't finished yet. <a href="${SETUP_PATH}">Finish setting it up</a>.</p>` : ""}
		<section class="hero">
			<div class="hero-copy">
				<p class="eyebrow">GitHub App · MIT · one Worker</p>
				<h1>Continuous integration that runs entirely on Cloudflare</h1>
				<p class="lead">Every check is a check run on your pull requests. Tests run in Dynamic Workers or in a container per run, progress streams live, and nothing runs outside your own Cloudflare account.</p>
				<p class="actions">
					<a class="button primary" href="${DOCS_PATH}">Read the docs</a>
					<a class="button" href="${docLink("self-hosting")}">Run your own</a>
					<a class="text-link" href="${REPO_URL}" rel="noopener">Source on GitHub →</a>
				</p>
			</div>
			${checksPanel()}
		</section>

		<section class="band">
			<header class="section-head">
				<p class="kicker">Checks</p>
				<h2>Five checks, each its own check run</h2>
				<p>Branch protection can require any of them. Turn them on per repository.</p>
			</header>
			<dl class="checks">
				${CHECKS.map((c) => `<div><dt><span class="dot ok" aria-hidden="true"></span><a href="${docLink(c.link)}">${esc(c.name)}</a></dt><dd>${esc(c.body)}</dd></div>`).join("")}
			</dl>
		</section>

		<section class="band">
			<header class="section-head">
				<p class="kicker">Built for agents</p>
				<h2>Cheap runs for pull requests that get pushed all day</h2>
			</header>
			<ol class="features">
				${FEATURES.map((f) => `<li><h3><a href="${docLink(f.link)}">${esc(f.name)}</a></h3><p>${f.body}</p></li>`).join("")}
			</ol>
		</section>

		<section class="band">
			<header class="section-head">
				<p class="kicker">How it works</p>
				<h2>From webhook to check run, on Cloudflare only</h2>
			</header>
			<ol class="flow">
				${FLOW.map((f) => `<li><h3>${esc(f.step)}</h3><p>${esc(f.body)}</p><p class="product">${esc(f.product)}</p></li>`).join("")}
			</ol>
			<p><a class="text-link" href="${docLink("architecture")}">Read the architecture →</a></p>
		</section>

		<section class="cta">
			<div>
				<h2>Run it on your own account</h2>
				<p>Fork the repository, import it in Workers Builds, and open <code>/setup</code>. The page creates the GitHub App for you. You need Workers Paid.</p>
			</div>
			<a class="button primary" href="${docLink("self-hosting")}">Self-hosting guide</a>
		</section>`,
	);
}

function renderDocsPage(pages: DocPage[], page: DocPage | undefined): string {
	const href = (p: DocPage) => (p.slug === "index" ? DOCS_PATH : `${DOCS_PATH}/${p.slug}`);
	const label = (p: DocPage) => (p.slug === "index" ? "Introduction" : p.title);
	const item = (p: DocPage) => `<li><a href="${href(p)}"${p.slug === page?.slug ? ' aria-current="page"' : ""}>${esc(label(p))}</a></li>`;
	const sections = [...new Set(pages.map((p) => p.section))];
	const nav = sections.map((section) => `<p class="kicker">${esc(section)}</p><ul>${pages.filter((p) => p.section === section).map(item).join("")}</ul>`).join("");
	const at = page ? pages.indexOf(page) : -1;
	const prev = at > 0 ? pages[at - 1] : undefined;
	const next = at >= 0 && at < pages.length - 1 ? pages[at + 1] : undefined;
	const pager = page
		? `<nav class="pager" aria-label="Pages">
				${prev ? `<a class="prev" href="${href(prev)}"><span>Previous</span>${esc(label(prev))}</a>` : "<span></span>"}
				${next ? `<a class="next" href="${href(next)}"><span>Next</span>${esc(label(next))}</a>` : "<span></span>"}
			</nav>
			<p class="edit"><a href="${REPO_URL}/blob/main/docs/${page.slug}.md" rel="noopener">Edit this page on GitHub</a></p>`
		: "";
	const body = page ? page.html : `<h1>Page not found</h1><p>This page doesn't exist. Start from the <a href="${DOCS_PATH}">introduction</a>.</p>`;
	return layout(
		page ? `${page.title} · quality-flare docs` : "Not found · quality-flare docs",
		"Documentation of quality-flare, continuous integration on Cloudflare.",
		`<div class="docs">
			<nav class="sidebar" aria-label="Documentation">${nav}</nav>
			<article class="prose">${body}${pager}</article>
		</div>`,
	);
}

/** The mark: a check whose long arm trails off into a flare. The trail takes the text color, the flare the accent, so each page styles it. */
export const MARK = `<svg class="mark" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M1.477 14.973 7.25 20.746l5.773-5.773-2.546-2.546L7.25 15.654l-3.227-3.227ZM13.8 13.488l3.117-3.117-1.838-1.838-3.117 3.117Z"/><circle class="mark-flare" cx="19.25" cy="6.2" r="3"/></svg>`;

/** The tab icon: the mark without the middle of the trail, which blurs at 16px, colored for light and dark tabs. */
const FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><style>path{fill:#1c1814}circle{fill:#c2410c}@media (prefers-color-scheme:dark){path{fill:#f2ece4}circle{fill:#fb8c4a}}</style><path d="M1.727 14.773 7.5 20.546l8.773-8.773-2.546-2.546L7.5 15.454l-3.227-3.227Z"/><circle cx="19.5" cy="6" r="3"/></svg>`;
export const FAVICON = `<link rel="icon" href="data:image/svg+xml,${encodeURIComponent(FAVICON_SVG)}">`;

function layout(title: string, description: string, main: string): string {
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<meta name="theme-color" content="#fbf8f3" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#14110e" media="(prefers-color-scheme: dark)">
${FAVICON}
<style>
	:root {
		--bg: #fbf8f3; --surface: #f4eee5; --raised: #fffdf9; --fg: #1c1814; --muted: #625a50; --faint: #8b8276; --line: #e3dace; --line-strong: #cfc3b3;
		--accent: #c2410c; --accent-hover: #9a3412; --accent-fg: #fff; --accent-soft: #fbe3d3; --ok: #1a7f37; --wait: #9a6700; --code: #efe7dc;
		--sans: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; --mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
		--radius: 10px; --wide: 1160px; color-scheme: light;
	}
	@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) {
		--bg: #14110e; --surface: #1b1814; --raised: #211d18; --fg: #f2ece4; --muted: #b0a698; --faint: #857b6e; --line: #2f2a24; --line-strong: #453d34;
		--accent: #fb8c4a; --accent-hover: #fdba74; --accent-fg: #1c1814; --accent-soft: #3a2416; --ok: #3fb950; --wait: #d29922; --code: #26211b; color-scheme: dark;
	} }
	:root[data-theme="dark"] {
		--bg: #14110e; --surface: #1b1814; --raised: #211d18; --fg: #f2ece4; --muted: #b0a698; --faint: #857b6e; --line: #2f2a24; --line-strong: #453d34;
		--accent: #fb8c4a; --accent-hover: #fdba74; --accent-fg: #1c1814; --accent-soft: #3a2416; --ok: #3fb950; --wait: #d29922; --code: #26211b; color-scheme: dark;
	}
	* { box-sizing: border-box; }
	html { -webkit-text-size-adjust: 100%; }
	body { margin: 0; background: var(--bg); color: var(--fg); font: 16px/1.6 var(--sans); font-feature-settings: "kern", "liga", "tnum"; -webkit-font-smoothing: antialiased; }
	a { color: var(--accent); text-underline-offset: 3px; text-decoration-thickness: 1px; }
	a:hover { color: var(--accent-hover); }
	:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; border-radius: 4px; }
	code { font: 0.875em var(--mono); background: var(--code); padding: 0.12em 0.4em; border-radius: 5px; overflow-wrap: anywhere; }
	h1, h2, h3 { text-wrap: balance; }
	p { text-wrap: pretty; }

	.top { position: sticky; top: 0; z-index: 5; background: color-mix(in srgb, var(--bg) 88%, transparent); backdrop-filter: blur(10px); border-bottom: 1px solid var(--line); }
	.top div { display: flex; align-items: center; gap: 24px; max-width: var(--wide); margin: 0 auto; padding: 12px 16px; }
	.brand { display: flex; align-items: center; gap: 10px; margin-right: auto; color: var(--fg); text-decoration: none; font-weight: 700; letter-spacing: -0.01em; }
	.brand:hover { color: var(--fg); }
	.mark { width: 24px; height: 24px; color: var(--fg); }
	.mark-flare { fill: var(--accent); }
	.top a { white-space: nowrap; }
	.top a:not(.brand) { color: var(--muted); text-decoration: none; font-size: 15px; }
	@media (max-width: 480px) { .top div { gap: 16px; } .top .wide-only { display: none; } }
	.top a:not(.brand):hover, .top a[aria-current] { color: var(--fg); }
	main { max-width: var(--wide); margin: 0 auto; padding: 0 16px 80px; }
	.banner { margin: 20px 0 0; padding: 10px 14px; border: 1px solid var(--accent); border-radius: var(--radius); background: var(--accent-soft); }

	.kicker, .eyebrow { font: 600 12px/1.4 var(--mono); letter-spacing: 0.08em; text-transform: uppercase; color: var(--accent); margin: 0 0 12px; }
	.hero { display: grid; grid-template-columns: minmax(0, 1.1fr) minmax(0, 0.9fr); gap: 56px; align-items: center; padding: 80px 0 72px; }
	.hero h1 { font-size: clamp(36px, 5.4vw, 60px); line-height: 1.04; letter-spacing: -0.035em; margin: 0 0 22px; font-weight: 750; }
	.lead { font-size: clamp(17px, 2vw, 19px); color: var(--muted); margin: 0 0 32px; max-width: 34em; }
	.actions { display: flex; flex-wrap: wrap; align-items: center; gap: 12px 16px; margin: 0; }
	.button { display: inline-flex; align-items: center; padding: 11px 20px; border-radius: 8px; border: 1px solid var(--line-strong); color: var(--fg); background: var(--raised); text-decoration: none; font-weight: 600; font-size: 15px; transition: border-color .15s, background .15s, transform .15s; }
	.button:hover { color: var(--fg); border-color: var(--fg); }
	.button.primary { background: var(--accent); border-color: var(--accent); color: var(--accent-fg); }
	.button.primary:hover { background: var(--accent-hover); border-color: var(--accent-hover); color: var(--accent-fg); }
	.button:active { transform: translateY(1px); }
	.text-link { font-weight: 600; text-decoration: none; font-size: 15px; }

	.panel { margin: 0; background: var(--raised); border: 1px solid var(--line-strong); border-radius: 12px; box-shadow: 0 1px 0 var(--line), 0 24px 48px -28px rgb(60 30 10 / 0.35); overflow: hidden; font-size: 14px; }
	.panel-head { display: flex; align-items: center; gap: 10px; padding: 14px 16px; border-bottom: 1px solid var(--line); flex-wrap: wrap; }
	.panel-head .muted { color: var(--muted); margin-left: auto; font-size: 13px; }
	.panel ul { list-style: none; margin: 0; padding: 6px 0; }
	.panel li { display: grid; grid-template-columns: 10px auto 1fr; align-items: baseline; gap: 10px; padding: 7px 16px; }
	.panel .name { font-weight: 600; white-space: nowrap; }
	.panel .detail { color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
	.panel-comment { display: flex; align-items: center; gap: 10px; padding: 12px 16px; border-top: 1px solid var(--line); background: var(--surface); }
	.avatar { width: 20px; height: 20px; border-radius: 50%; background: linear-gradient(135deg, var(--line-strong), var(--faint)); flex: none; }
	.reaction { margin-left: auto; border: 1px solid var(--line-strong); border-radius: 999px; padding: 0 8px; font-size: 13px; background: var(--raised); }
	.dot { display: inline-block; width: 10px; height: 10px; border-radius: 50%; flex: none; }
	.dot.ok { background: var(--ok); box-shadow: 0 0 0 3px color-mix(in srgb, var(--ok) 20%, transparent); }
	.dot.wait { background: var(--wait); }

	.band { padding: 72px 0; border-top: 1px solid var(--line); }
	.section-head { max-width: 640px; margin-bottom: 40px; }
	.section-head h2 { font-size: clamp(26px, 3.4vw, 36px); line-height: 1.15; letter-spacing: -0.025em; margin: 0 0 10px; }
	.section-head p:not(.kicker) { color: var(--muted); margin: 0; font-size: 17px; }

	.checks { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 0 48px; margin: 0; }
	.checks div { padding: 18px 0; border-top: 1px solid var(--line); }
	.checks dt { display: flex; align-items: center; gap: 12px; font-weight: 650; font-size: 17px; margin-bottom: 4px; }
	.checks dt a { color: var(--fg); text-decoration: none; }
	.checks dt a:hover { color: var(--accent); }
	.checks dd { margin: 0 0 0 22px; color: var(--muted); }

	.features { list-style: none; counter-reset: feature; padding: 0; margin: 0; display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 40px 48px; }
	.features li { counter-increment: feature; }
	.features li::before { content: counter(feature, decimal-leading-zero); display: block; font: 600 13px var(--mono); color: var(--faint); padding-bottom: 10px; margin-bottom: 14px; border-bottom: 1px solid var(--line-strong); }
	.features h3 { font-size: 18px; margin: 0 0 6px; letter-spacing: -0.01em; }
	.features h3 a { color: var(--fg); text-decoration: none; }
	.features h3 a:hover { color: var(--accent); }
	.features p { margin: 0; color: var(--muted); }

	.flow { list-style: none; padding: 0; margin: 0 0 28px; display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); counter-reset: step; }
	.flow li { counter-increment: step; position: relative; padding: 0 24px 0 0; }
	.flow li::before { content: counter(step); display: grid; place-items: center; width: 32px; height: 32px; border-radius: 50%; border: 1.5px solid var(--accent); color: var(--accent); font: 600 14px var(--mono); background: var(--bg); position: relative; z-index: 1; margin-bottom: 16px; }
	.flow li:not(:last-child)::after { content: ""; position: absolute; top: 16px; left: 32px; right: 0; height: 1.5px; background: repeating-linear-gradient(90deg, var(--line-strong) 0 6px, transparent 6px 10px); }
	.flow h3 { font-size: 18px; margin: 0 0 6px; }
	.flow p { margin: 0; color: var(--muted); }
	.flow .product { margin-top: 10px; font: 12px/1.5 var(--mono); color: var(--fg); }

	.cta { display: flex; align-items: center; justify-content: space-between; gap: 24px 40px; flex-wrap: wrap; margin-top: 24px; padding: 36px 40px; border-radius: 16px; background: var(--surface); border: 1px solid var(--line); }
	.cta h2 { margin: 0 0 6px; font-size: 26px; letter-spacing: -0.02em; }
	.cta p { margin: 0; color: var(--muted); max-width: 40em; }

	@media (max-width: 900px) {
		.hero { grid-template-columns: 1fr; gap: 40px; padding: 48px 0 56px; }
		.features { grid-template-columns: repeat(2, minmax(0, 1fr)); }
		.flow { grid-template-columns: 1fr 1fr; gap: 32px 0; }
		.flow li:nth-child(2)::after { display: none; }
	}
	@media (max-width: 600px) {
		.features, .flow { grid-template-columns: 1fr; }
		.flow li::after { display: none; }
		.band { padding: 56px 0; }
		.cta { padding: 28px 20px; }
		.panel .detail { white-space: normal; }
		.panel li { grid-template-columns: 10px 1fr; }
		.panel .detail { grid-column: 2; }
	}

	.docs { display: grid; grid-template-columns: 220px minmax(0, 1fr); gap: 56px; padding-top: 40px; }
	.sidebar ul { list-style: none; padding: 0; margin: 0; border-left: 1px solid var(--line); }
	.sidebar .kicker { color: var(--faint); margin: 24px 0 8px; }
	.sidebar .kicker:first-child { margin-top: 0; }
	.sidebar { align-self: start; position: sticky; top: 72px; }
	.sidebar a { display: block; padding: 6px 14px; margin-left: -1px; border-left: 2px solid transparent; color: var(--muted); text-decoration: none; font-size: 15px; }
	.sidebar a:hover { color: var(--fg); }
	.sidebar a[aria-current] { color: var(--fg); border-left-color: var(--accent); font-weight: 600; }
	@media (max-width: 800px) {
		.docs { grid-template-columns: 1fr; gap: 20px; padding-top: 20px; }
		.sidebar { position: static; }
		.sidebar ul { display: flex; flex-wrap: wrap; gap: 4px; border: 0; }
		.sidebar a { border: 1px solid var(--line); border-radius: 999px; padding: 4px 12px; margin: 0; font-size: 14px; }
		.sidebar a[aria-current] { border-color: var(--accent); background: var(--accent-soft); }
	}
	.prose { max-width: 740px; min-width: 0; }
	.prose h1 { font-size: clamp(32px, 4.4vw, 42px); line-height: 1.1; letter-spacing: -0.03em; margin: 0 0 20px; }
	.prose h1 + p { font-size: 18px; color: var(--muted); }
	.prose h2 { font-size: 24px; letter-spacing: -0.015em; margin: 52px 0 12px; padding-top: 20px; border-top: 1px solid var(--line); scroll-margin-top: 72px; }
	.prose h3 { font-size: 18px; margin: 32px 0 8px; scroll-margin-top: 72px; }
	.prose .anchor { color: inherit; text-decoration: none; }
	.prose .anchor:hover::after { content: " #"; color: var(--faint); font-weight: 400; }
	.prose pre { background: var(--code); border: 1px solid var(--line); border-radius: var(--radius); padding: 14px 16px; overflow-x: auto; font-size: 14px; line-height: 1.55; }
	.prose pre code { background: none; padding: 0; overflow-wrap: normal; font-size: inherit; }
	.prose table { width: 100%; border-collapse: collapse; font-size: 15px; display: block; overflow-x: auto; margin: 20px 0; }
	.prose th, .prose td { text-align: left; padding: 10px 12px 10px 0; border-bottom: 1px solid var(--line); vertical-align: top; }
	.prose th { color: var(--faint); font: 600 12px var(--mono); letter-spacing: 0.06em; text-transform: uppercase; border-bottom-color: var(--line-strong); }
	.prose td:first-child code { white-space: nowrap; overflow-wrap: normal; }
	.prose blockquote { margin: 20px 0; padding: 4px 18px; border-left: 3px solid var(--accent); background: var(--surface); border-radius: 0 8px 8px 0; }
	.prose li { margin: 6px 0; }
	.prose li::marker { color: var(--faint); }
	.pager { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-top: 64px; }
	.pager a { display: flex; flex-direction: column; gap: 2px; padding: 14px 18px; border: 1px solid var(--line); border-radius: var(--radius); text-decoration: none; color: var(--fg); font-weight: 600; }
	.pager a:hover { border-color: var(--accent); color: var(--fg); }
	.pager span { font: 12px var(--mono); color: var(--faint); font-weight: 400; text-transform: uppercase; letter-spacing: 0.06em; }
	.pager .next { text-align: right; }
	.edit { margin-top: 24px; font-size: 14px; }

	footer { border-top: 1px solid var(--line); color: var(--muted); font-size: 14px; }
	footer div { max-width: var(--wide); margin: 0 auto; padding: 24px 16px; display: flex; flex-wrap: wrap; align-items: center; gap: 8px 24px; }
	footer span { margin-right: auto; }
	footer a { color: var(--muted); }
	@media (prefers-reduced-motion: reduce) { * { transition: none !important; } }
</style>
</head>
<body>
<header class="top"><div>
	<a class="brand" href="/">${MARK}quality-flare</a>
	<a href="${DOCS_PATH}">Docs</a>
	<a class="wide-only" href="${DOCS_PATH}/self-hosting">Self-hosting</a>
	<a href="${REPO_URL}" rel="noopener">GitHub</a>
</div></header>
<main>${main}</main>
<footer><div><span>quality-flare is open source under the MIT license.</span><a href="${DOCS_PATH}">Docs</a><a href="${REPO_URL}" rel="noopener">GitHub</a></div></footer>
</body>
</html>`;
}

function html(body: string, status = 200): Response {
	return new Response(body, {
		status,
		headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "public, max-age=300" },
	});
}
