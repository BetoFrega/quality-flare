import pages from "virtual:docs";
import { esc } from "./admin/page.ts";
import { SETUP_PATH } from "./setup.ts";

/**
 * The public pages: what quality-flare is, at the root of the Worker, and its documentation under /docs,
 * rendered from docs/*.md at build time (build/docs.ts). Neither needs sign-in nor reads any setting
 * beyond whether /setup is finished.
 */

export const DOCS_PATH = "/docs";
const REPO_URL = "https://github.com/BetoFrega/quality-flare";

/** The documentation page at `pathname`, or a 404 page. */
export function handleDocs(pathname: string): Response {
	const slug = pathname.replace(/\/+$/, "").slice(DOCS_PATH.length + 1) || "index";
	const page = pages.find((p) => p.slug === slug);
	if (!page) return html(renderDocsPage(undefined), 404);
	return html(renderDocsPage(page));
}

/** The home page. `pending` adds a note that this installation's /setup isn't finished. */
export function handleHome(pending: boolean): Response {
	return html(renderHome(pending));
}

const CHECKS = [
	{
		name: "Tests",
		body: "Runs your vitest suite inside Dynamic Workers created for each run, sharded through a Queue. No config for the common case: test files, the lockfile and tsconfig paths are found on their own.",
		link: "checks#tests",
	},
	{
		name: "Container tests",
		body: "Runs your own vitest and config in a fresh container, then your named commands (Typecheck, Lint…), each as its own check run with live logs.",
		link: "checks#container-tests",
	},
	{
		name: "Closes an issue",
		body: "Passes when the pull request closes an issue, by keyword or sidebar link, or carries the no-issue label.",
		link: "checks#closes-an-issue",
	},
	{
		name: "Codex review",
		body: "Holds the merge until every Codex review thread is resolved, and waits while Codex is still reviewing.",
		link: "checks#codex-review",
	},
	{
		name: "Dependabot auto-merge",
		body: "Turns on squash auto-merge for Dependabot pull requests, without a GitHub Actions workflow.",
		link: "checks#dependabot-auto-merge",
	},
];

const FEATURES = [
	{ name: "Tests on demand", body: "Pushes don't spend a run. Comment <code>/quality-flare run</code> when the pull request is ready, and one status comment tells agents and people where it stands." },
	{ name: "Only what changed", body: "Pull requests run the tests that depend on the change; a daily full run on the default branch catches the rest and opens an issue when it fails." },
	{ name: "Caches on R2", body: "Turborepo's remote cache, tool caches such as ESLint's and tsc's, and container snapshots that skip the install." },
	{ name: "Live progress", body: "Check runs update every few seconds with counts and failures, and the admin streams each test as it finishes." },
	{ name: "Costs you can see", body: "The admin shows the account's measured usage next to an estimate for every run, repository and day." },
	{ name: "Off until you say so", body: "Every repository and every check starts disabled. Turn them on one by one in the admin, behind Cloudflare Access." },
];

const PRODUCTS = ["Workers", "Dynamic Workers", "Containers", "Queues", "Durable Objects", "D1", "KV", "R2", "Access", "Workers Builds"];

function renderHome(pending: boolean): string {
	const docLink = (path: string) => `${DOCS_PATH}/${path}`;
	return layout(
		"quality-flare: CI on Cloudflare",
		"Continuous integration that runs entirely on Cloudflare, delivered as a GitHub App.",
		`${pending ? `<p class="banner">This installation isn't finished yet. <a href="${SETUP_PATH}">Finish setting it up</a>.</p>` : ""}
		<section class="hero">
			<p class="eyebrow">GitHub App · open source · runs on Cloudflare</p>
			<h1>Continuous integration that runs entirely on Cloudflare</h1>
			<p class="lead">quality-flare turns each check into a check run on your pull requests. Tests run in Dynamic Workers or in a container per run, results stream live, and the whole thing is one Worker you deploy to your own Cloudflare account.</p>
			<p class="actions">
				<a class="button primary" href="${DOCS_PATH}">Read the docs</a>
				<a class="button" href="${docLink("self-hosting")}">Run your own</a>
				<a class="button" href="${REPO_URL}" rel="noopener">Source on GitHub</a>
			</p>
		</section>

		<section>
			<h2>Checks</h2>
			<p class="section-lead">Each check reports as its own check run, so branch protection can require any of them. Turn them on per repository.</p>
			<ul class="cards">
				${CHECKS.map((c) => `<li><h3><a href="${docLink(c.link)}">${esc(c.name)}</a></h3><p>${esc(c.body)}</p></li>`).join("")}
			</ul>
		</section>

		<section>
			<h2>Built for cheap, agent-driven pull requests</h2>
			<ul class="cards features">
				${FEATURES.map((f) => `<li><h3>${esc(f.name)}</h3><p>${f.body}</p></li>`).join("")}
			</ul>
		</section>

		<section>
			<h2>How it works</h2>
			<ol class="flow">
				<li><strong>GitHub sends a webhook</strong> to the Worker, which checks its signature and answers right away.</li>
				<li><strong>The Worker runs each enabled check</strong> with an installation token and opens a check run on the pull request's head commit.</li>
				<li><strong>Tests fan out</strong> to Dynamic Workers through a Queue, or to a container started by a Durable Object.</li>
				<li><strong>Results come back</strong> as check runs, a status comment and live pages in the admin; run history lives in D1.</li>
			</ol>
			<p><a href="${docLink("architecture")}">Read the architecture</a></p>
		</section>

		<section>
			<h2>Only Cloudflare</h2>
			<p class="section-lead">No runners to keep, no other cloud. Deploys run on Workers Builds from your fork.</p>
			<ul class="chips">${PRODUCTS.map((p) => `<li>${esc(p)}</li>`).join("")}</ul>
		</section>`,
	);
}

function renderDocsPage(page: { slug: string; title: string; html: string } | undefined): string {
	const nav = pages
		.map((p) => {
			const href = p.slug === "index" ? DOCS_PATH : `${DOCS_PATH}/${p.slug}`;
			return `<li><a href="${href}"${p.slug === page?.slug ? ' aria-current="page"' : ""}>${esc(p.slug === "index" ? "Introduction" : p.title)}</a></li>`;
		})
		.join("");
	const source = page ? `<p class="edit"><a href="${REPO_URL}/blob/main/docs/${page.slug}.md" rel="noopener">Edit this page on GitHub</a></p>` : "";
	const body = page ? page.html : `<h1>Page not found</h1><p>This page doesn't exist. Start from the <a href="${DOCS_PATH}">introduction</a>.</p>`;
	return layout(
		page ? `${page.title} · quality-flare docs` : "Not found · quality-flare docs",
		"Documentation of quality-flare, continuous integration on Cloudflare.",
		`<div class="docs">
			<nav class="sidebar" aria-label="Documentation"><ul>${nav}</ul></nav>
			<article class="prose">${body}${source}</article>
		</div>`,
	);
}

function layout(title: string, description: string, main: string): string {
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<style>
	:root { --bg: #fffdf9; --fg: #1d1a16; --muted: #5f5a52; --line: #e6dfd4; --panel: #f7f2ea; --accent: #c2410c; --accent-fg: #fff; --code: #f1ebe1; color-scheme: light; }
	@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { --bg: #13110f; --fg: #f3eee7; --muted: #a8a096; --line: #34302b; --panel: #1c1916; --accent: #fb923c; --accent-fg: #1d1a16; --code: #24201c; color-scheme: dark; } }
	:root[data-theme="dark"] { --bg: #13110f; --fg: #f3eee7; --muted: #a8a096; --line: #34302b; --panel: #1c1916; --accent: #fb923c; --accent-fg: #1d1a16; --code: #24201c; color-scheme: dark; }
	* { box-sizing: border-box; }
	body { margin: 0; background: var(--bg); color: var(--fg); font: 16px/1.6 system-ui, -apple-system, "Segoe UI", sans-serif; }
	a { color: var(--accent); }
	code { font: 0.9em ui-monospace, SFMono-Regular, Menlo, monospace; background: var(--code); padding: 0.1em 0.35em; border-radius: 4px; overflow-wrap: anywhere; }
	.top { display: flex; align-items: center; gap: 20px; padding: 14px 16px; border-bottom: 1px solid var(--line); max-width: 1120px; margin: 0 auto; }
	.top .brand { font-weight: 700; color: var(--fg); text-decoration: none; margin-right: auto; display: flex; align-items: center; gap: 8px; }
	.top .brand::before { content: ""; width: 14px; height: 14px; border-radius: 50%; background: radial-gradient(circle at 35% 35%, #fdba74, var(--accent)); }
	.top a:not(.brand) { color: var(--muted); text-decoration: none; font-size: 15px; }
	.top a:not(.brand):hover { color: var(--fg); }
	main { max-width: 1120px; margin: 0 auto; padding: 0 16px 64px; }
	.banner { margin: 16px 0 0; padding: 10px 14px; border: 1px solid var(--accent); border-radius: 8px; background: var(--panel); }
	.hero { padding: 72px 0 40px; max-width: 760px; }
	.eyebrow { color: var(--accent); font-weight: 600; font-size: 14px; letter-spacing: 0.02em; margin: 0 0 12px; }
	.hero h1 { font-size: clamp(32px, 6vw, 52px); line-height: 1.1; margin: 0 0 20px; letter-spacing: -0.02em; text-wrap: balance; }
	.lead { font-size: 19px; color: var(--muted); margin: 0 0 28px; }
	.actions { display: flex; flex-wrap: wrap; gap: 10px; margin: 0; }
	.button { display: inline-block; padding: 10px 18px; border-radius: 8px; border: 1px solid var(--line); color: var(--fg); text-decoration: none; font-weight: 600; background: var(--panel); }
	.button.primary { background: var(--accent); border-color: var(--accent); color: var(--accent-fg); }
	section { padding: 32px 0; }
	section h2 { font-size: 26px; margin: 0 0 8px; letter-spacing: -0.01em; }
	.section-lead { color: var(--muted); margin: 0 0 20px; max-width: 680px; }
	.cards { list-style: none; padding: 0; margin: 20px 0 0; display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 14px; }
	.cards li { border: 1px solid var(--line); border-radius: 10px; padding: 18px; background: var(--panel); }
	.cards h3 { margin: 0 0 6px; font-size: 17px; }
	.cards h3 a { color: var(--fg); text-decoration: none; }
	.cards h3 a:hover { color: var(--accent); }
	.cards p { margin: 0; color: var(--muted); font-size: 15px; }
	.flow { padding-left: 22px; max-width: 720px; }
	.flow li { margin: 0 0 10px; }
	.chips { list-style: none; padding: 0; margin: 0; display: flex; flex-wrap: wrap; gap: 8px; }
	.chips li { border: 1px solid var(--line); border-radius: 999px; padding: 4px 12px; font-size: 14px; }
	.docs { display: grid; grid-template-columns: 210px minmax(0, 1fr); gap: 40px; padding-top: 32px; }
	.sidebar ul { list-style: none; padding: 0; margin: 0; position: sticky; top: 16px; }
	.sidebar a { display: block; padding: 5px 10px; border-radius: 6px; color: var(--muted); text-decoration: none; font-size: 15px; }
	.sidebar a:hover { color: var(--fg); }
	.sidebar a[aria-current] { color: var(--fg); background: var(--panel); font-weight: 600; }
	@media (max-width: 760px) { .docs { grid-template-columns: 1fr; gap: 16px; padding-top: 16px; } .sidebar ul { position: static; display: flex; flex-wrap: wrap; gap: 4px; } }
	.prose { max-width: 760px; min-width: 0; }
	.prose h1 { font-size: 34px; line-height: 1.2; margin: 0 0 16px; letter-spacing: -0.01em; }
	.prose h2 { font-size: 24px; margin: 40px 0 10px; padding-top: 8px; border-top: 1px solid var(--line); }
	.prose h3 { font-size: 19px; margin: 28px 0 8px; }
	.prose .anchor { color: inherit; text-decoration: none; }
	.prose .anchor:hover::after { content: " #"; color: var(--muted); }
	.prose pre { background: var(--code); border: 1px solid var(--line); border-radius: 8px; padding: 12px 14px; overflow-x: auto; font-size: 14px; line-height: 1.5; }
	.prose pre code { background: none; padding: 0; overflow-wrap: normal; }
	.prose table { width: 100%; border-collapse: collapse; font-size: 15px; display: block; overflow-x: auto; }
	.prose th, .prose td { text-align: left; padding: 8px 10px; border-bottom: 1px solid var(--line); vertical-align: top; }
	.prose th { color: var(--muted); font-weight: 600; }
	.prose td:first-child code { white-space: nowrap; overflow-wrap: normal; }
	.prose blockquote { margin: 16px 0; padding: 4px 16px; border-left: 3px solid var(--accent); background: var(--panel); border-radius: 0 6px 6px 0; }
	.prose li { margin: 4px 0; }
	.edit { margin-top: 48px; font-size: 14px; }
	footer { border-top: 1px solid var(--line); color: var(--muted); font-size: 14px; }
	footer div { max-width: 1120px; margin: 0 auto; padding: 20px 16px; display: flex; flex-wrap: wrap; gap: 8px 20px; }
	footer a { color: var(--muted); }
</style>
</head>
<body>
<header class="top">
	<a class="brand" href="/">quality-flare</a>
	<a href="${DOCS_PATH}">Docs</a>
	<a href="${REPO_URL}" rel="noopener">GitHub</a>
</header>
<main>${main}</main>
<footer><div><span>quality-flare is open source under the MIT license.</span><a href="${REPO_URL}" rel="noopener">GitHub</a><a href="${DOCS_PATH}">Docs</a></div></footer>
</body>
</html>`;
}

function html(body: string, status = 200): Response {
	return new Response(body, {
		status,
		headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "public, max-age=300" },
	});
}
