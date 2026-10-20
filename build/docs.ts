import { statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { Marked } from "marked";
import type { Plugin } from "vite";

const ID = "virtual:docs";
const RESOLVED = `\0${ID}`;
const DIR = new URL("../docs/", import.meta.url);

/** The pages under /docs, in the sidebar's order: docs/<slug>.md, with "index" served at /docs itself. */
export const PAGES = ["index", "self-hosting", "checks", "configuration", "on-demand", "admin", "architecture"];

export interface DocPage {
	slug: string;
	/** The page's first `# ` heading. */
	title: string;
	html: string;
}

/**
 * Renders docs/*.md to HTML at build time and exposes the pages as the default export of
 * `virtual:docs`, so the Worker serves /docs without a Markdown parser. Links between the
 * files (`checks.md#tests`) become links between the pages (`/docs/checks#tests`), so the
 * same files read well on GitHub.
 */
export function docs(): Plugin {
	return {
		name: "quality-flare:docs",
		resolveId: (id) => (id === ID ? RESOLVED : undefined),
		async load(id) {
			if (id !== RESOLVED) return;
			const pages = await Promise.all(
				PAGES.map(async (slug) => {
					const file = new URL(`${slug}.md`, DIR);
					this.addWatchFile(file.pathname);
					return renderDoc(slug, await readFile(file, "utf8"));
				}),
			);
			return `export default ${JSON.stringify(pages)};`;
		},
	};
}

export function renderDoc(slug: string, markdown: string): DocPage {
	const title = /^# (.+)$/m.exec(markdown)?.[1].trim();
	if (!title) throw new Error(`docs/${slug}.md has no "# " title`);
	const seen = new Map<string, number>();
	const marked = new Marked({
		gfm: true,
		renderer: {
			heading({ tokens, depth }) {
				const text = this.parser.parseInline(tokens);
				// GitHub's anchors: lowercase, punctuation dropped, spaces as dashes, repeats numbered.
				const base = text
					.replace(/<[^>]+>/g, "")
					.replace(/&[^;]+;/g, "")
					.toLowerCase()
					.trim()
					.replace(/[^\p{L}\p{N} _-]/gu, "")
					.replace(/ /g, "-");
				const count = seen.get(base) ?? 0;
				seen.set(base, count + 1);
				const anchor = count ? `${base}-${count}` : base;
				return `<h${depth} id="${anchor}"><a class="anchor" href="#${anchor}">${text}</a></h${depth}>\n`;
			},
			link({ href, title, tokens }) {
				const text = this.parser.parseInline(tokens);
				const page = /^(?:\.\/)?([a-z-]+)\.md(#.*)?$/.exec(href);
				let target = href;
				if (page) {
					if (!PAGES.includes(page[1])) throw new Error(`docs/${slug}.md links to ${href}, which is not in PAGES`);
					target = `${page[1] === "index" ? "/docs" : `/docs/${page[1]}`}${page[2] ?? ""}`;
				} else if (href.startsWith("../")) {
					// Repository files and folders, which the Worker doesn't serve. Throws when the path doesn't exist.
					const path = href.slice(3).replace(/#.*$/, "");
					const kind = statSync(new URL(`../${path}`, import.meta.url)).isDirectory() ? "tree" : "blob";
					target = `https://github.com/BetoFrega/quality-flare/${kind}/main/${href.slice(3)}`;
				}
				const external = /^https?:/.test(target) ? ' rel="noopener"' : "";
				return `<a href="${target}"${title ? ` title="${title}"` : ""}${external}>${text}</a>`;
			},
		},
	});
	return { slug, title, html: marked.parse(markdown, { async: false }) };
}
