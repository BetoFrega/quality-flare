// Parses GitHub closing keywords ("Closes #12", "fixes owner/repo#3",
// "resolved: https://github.com/o/r/issues/7") out of free text.
// https://docs.github.com/en/issues/tracking-your-work-with-issues/using-issues/linking-a-pull-request-to-an-issue

export interface IssueRef {
	/** "owner/repo", or undefined when the reference is to the PR's own repository. */
	repo?: string;
	number: number;
}

const KEYWORDS = "close|closes|closed|fix|fixes|fixed|resolve|resolves|resolved";
const REF = String.raw`(?:https?:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/issues\/(\d+)|(?:([\w.-]+\/[\w.-]+))?#(\d+))`;
const PATTERN = new RegExp(String.raw`(?<![\w-])(?:${KEYWORDS}):?\s+${REF}(?![\w])`, "gi");

export function parseClosingRefs(text: string | null | undefined): IssueRef[] {
	if (!text) return [];
	const refs: IssueRef[] = [];
	const seen = new Set<string>();
	for (const m of stripCode(text).matchAll(PATTERN)) {
		const repo = m[1] ?? m[3];
		const number = Number(m[2] ?? m[4]);
		const key = `${repo?.toLowerCase() ?? ""}#${number}`;
		if (seen.has(key)) continue;
		seen.add(key);
		refs.push(repo ? { repo, number } : { number });
	}
	return refs;
}

// GitHub ignores keywords inside code blocks and inline code, and so do we.
function stripCode(text: string): string {
	return text.replace(/```[\s\S]*?```/g, " ").replace(/`[^`\n]*`/g, " ");
}

export function formatRef(ref: IssueRef): string {
	return ref.repo ? `${ref.repo}#${ref.number}` : `#${ref.number}`;
}
