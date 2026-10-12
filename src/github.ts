import type { IssueRef } from "./checks/closes-issue/keywords.ts";
import { createAppJwt } from "./crypto.ts";
import type { CheckResult } from "./checks/types.ts";

const API = "https://api.github.com";

export interface AppCredentials {
	appId: string;
	privateKey: string;
}

export class GitHubClient {
	constructor(private readonly token: string) {}

	static async forInstallation(creds: AppCredentials, installationId: number): Promise<GitHubClient> {
		const jwt = await createAppJwt(creds.appId, creds.privateKey);
		const res = await request<{ token: string }>(jwt, "POST", `/app/installations/${installationId}/access_tokens`);
		return new GitHubClient(res.token);
	}

	/** Every repository the App is installed on, across all installations, sorted by name. */
	static async listInstalledRepos(creds: AppCredentials): Promise<InstalledRepo[]> {
		const jwt = await createAppJwt(creds.appId, creds.privateKey);
		const installations = await paginate<Installation>(jwt, "/app/installations", (page) => page as Installation[]);
		const repos: InstalledRepo[] = [];
		for (const installation of installations) {
			const client = await GitHubClient.forInstallation(creds, installation.id);
			const page = await paginate<InstalledRepo>(client.token, "/installation/repositories", (p) =>
				(p as { repositories: InstalledRepo[] }).repositories,
			);
			repos.push(...page.map(({ full_name, html_url, private: isPrivate }) => ({ full_name, html_url, private: isPrivate })));
		}
		return repos.sort((a, b) => a.full_name.localeCompare(b.full_name));
	}

	getPullRequest(repo: string, number: number): Promise<PullRequest> {
		return request(this.token, "GET", `/repos/${repo}/pulls/${number}`);
	}

	/** Issues GitHub will close when this PR merges: closing keywords plus issues linked in the sidebar. */
	async getLinkedIssues(repo: string, number: number): Promise<IssueRef[]> {
		const [owner, name] = repo.split("/");
		const data = await request<LinkedIssuesResponse>(this.token, "POST", "/graphql", {
			query: `query($owner: String!, $name: String!, $number: Int!) {
				repository(owner: $owner, name: $name) {
					pullRequest(number: $number) {
						closingIssuesReferences(first: 25) { nodes { number repository { nameWithOwner } } }
					}
				}
			}`,
			variables: { owner, name, number },
		});
		if (data.errors?.length) throw new Error(`GraphQL error: ${data.errors.map((e) => e.message).join("; ")}`);
		const nodes = data.data?.repository?.pullRequest?.closingIssuesReferences?.nodes ?? [];
		return nodes.map((n) =>
			n.repository.nameWithOwner.toLowerCase() === repo.toLowerCase()
				? { number: n.number }
				: { repo: n.repository.nameWithOwner, number: n.number },
		);
	}

	/** Review threads, reviewers, conversation comments and 👀 reactions on the PR, for review-based checks. */
	async getReviewActivity(repo: string, number: number): Promise<ReviewActivity> {
		const [owner, name] = repo.split("/");
		const data = await request<ReviewActivityResponse>(this.token, "POST", "/graphql", {
			query: `query($owner: String!, $name: String!, $number: Int!) {
				repository(owner: $owner, name: $name) {
					pullRequest(number: $number) {
						reviewThreads(first: 100) {
							nodes { isResolved isOutdated comments(first: 1) { nodes { author { login } body url } } }
						}
						reviews(last: 100) { nodes { author { login } } }
						comments(last: 100) { nodes { author { login } body } }
						reactionGroups { content reactors(first: 20) { nodes { ... on Bot { login } ... on User { login } } } }
					}
				}
			}`,
			variables: { owner, name, number },
		});
		if (data.errors?.length) throw new Error(`GraphQL error: ${data.errors.map((e) => e.message).join("; ")}`);
		const pr = data.data?.repository?.pullRequest;
		return {
			threads: (pr?.reviewThreads.nodes ?? []).flatMap((t) => {
				const first = t.comments.nodes[0];
				return first
					? [{ resolved: t.isResolved, outdated: t.isOutdated, author: first.author?.login, body: first.body, url: first.url }]
					: [];
			}),
			reviewers: (pr?.reviews.nodes ?? []).flatMap((r) => (r.author ? [r.author.login] : [])),
			comments: (pr?.comments.nodes ?? []).map((c) => ({ author: c.author?.login, body: c.body })),
			eyesFrom: (pr?.reactionGroups ?? [])
				.filter((g) => g.content === "EYES")
				.flatMap((g) => g.reactors.nodes.flatMap((n) => (n.login ? [n.login] : []))),
		};
	}

	/**
	 * Turns on auto-merge for the PR (GraphQL `enablePullRequestAutoMerge`). Resolves to GitHub's
	 * error messages, empty when it worked, since refusals such as "clean status" are expected outcomes.
	 */
	async enableAutoMerge(pullRequestNodeId: string, mergeMethod: MergeMethod): Promise<string[]> {
		const data = await request<{ errors?: { message: string }[] }>(this.token, "POST", "/graphql", {
			query: `mutation($id: ID!, $method: PullRequestMergeMethod!) {
				enablePullRequestAutoMerge(input: { pullRequestId: $id, mergeMethod: $method }) { clientMutationId }
			}`,
			variables: { id: pullRequestNodeId, method: mergeMethod },
		});
		return data.errors?.map((e) => e.message) ?? [];
	}

	/** The repository's files at `ref`, as GitHub's gzipped tarball. */
	async getTarball(repo: string, ref: string): Promise<ReadableStream<Uint8Array>> {
		const res = await fetch(`${API}/repos/${repo}/tarball/${ref}`, { headers: headers(this.token) });
		if (res.status === 403 || res.status === 404) {
			// Public repositories download without it, so this only shows up on private ones.
			throw new Error(
				`O GitHub respondeu ${res.status} ao baixar o código de ${repo}. A GitHub App precisa da permissão ` +
					`"Contents: Read-only", e a instalação precisa aceitar essa permissão (GitHub → Settings → Applications → quality-flare).`,
			);
		}
		if (!res.ok || !res.body) throw new Error(`GitHub GET tarball of ${repo}@${ref} failed: ${res.status}`);
		return res.body;
	}

	/** Every file path in the repository at `ref` (no contents). */
	async listFiles(repo: string, ref: string): Promise<string[]> {
		const tree = await request<{ tree: { path: string; type: string }[]; truncated: boolean }>(
			this.token,
			"GET",
			`/repos/${repo}/git/trees/${ref}?recursive=1`,
		);
		if (tree.truncated) throw new Error(`O repositório ${repo} tem arquivos demais para listar pela API do GitHub.`);
		return tree.tree.filter((e) => e.type === "blob").map((e) => e.path);
	}

	/**
	 * Creates an in-progress check run, to be completed later with `completeCheckRun`. Resolves to
	 * its id. `detailsUrl` is where "View more details" leads; GitHub uses the App's homepage without it.
	 */
	async startCheckRun(repo: string, headSha: string, name: string, title: string, detailsUrl?: string): Promise<number> {
		const run = await request<{ id: number }>(this.token, "POST", `/repos/${repo}/check-runs`, {
			name,
			head_sha: headSha,
			status: "in_progress",
			details_url: detailsUrl,
			output: { title, summary: title },
		});
		return run.id;
	}

	completeCheckRun(repo: string, checkRunId: number, result: CheckResult): Promise<unknown> {
		return request(this.token, "PATCH", `/repos/${repo}/check-runs/${checkRunId}`, {
			status: "completed",
			conclusion: result.conclusion,
			output: { title: result.title, summary: result.summary },
		});
	}

	createCheckRun(repo: string, headSha: string, name: string, result: CheckResult): Promise<unknown> {
		return request(this.token, "POST", `/repos/${repo}/check-runs`, {
			name,
			head_sha: headSha,
			status: "completed",
			conclusion: result.conclusion,
			output: { title: result.title, summary: result.summary },
		});
	}
}

export type MergeMethod = "MERGE" | "SQUASH" | "REBASE";

export interface PullRequest {
	number: number;
	node_id: string;
	user: { login: string };
	body: string | null;
	head: { sha: string };
	labels: { name: string }[];
}

export interface ReviewActivity {
	/** Each review thread, described by its first comment. */
	threads: { resolved: boolean; outdated: boolean; author?: string; body: string; url: string }[];
	/** Authors of the PR's reviews. */
	reviewers: string[];
	/** The PR's conversation comments, oldest first. */
	comments: { author?: string; body: string }[];
	/** Who reacted 👀 to the PR. */
	eyesFrom: string[];
}

export interface InstalledRepo {
	/** "owner/repo" */
	full_name: string;
	html_url: string;
	private: boolean;
}

interface Installation {
	id: number;
}

interface LinkedIssuesResponse {
	data?: {
		repository?: {
			pullRequest?: {
				closingIssuesReferences?: { nodes: { number: number; repository: { nameWithOwner: string } }[] };
			};
		};
	};
	errors?: { message: string }[];
}

interface ReviewActivityResponse {
	data?: {
		repository?: {
			pullRequest?: {
				reviewThreads: {
					nodes: { isResolved: boolean; isOutdated: boolean; comments: { nodes: { author: Author; body: string; url: string }[] } }[];
				};
				reviews: { nodes: { author: Author }[] };
				comments: { nodes: { author: Author; body: string }[] };
				reactionGroups: { content: string; reactors: { nodes: { login?: string }[] } }[];
			};
		};
	};
	errors?: { message: string }[];
}

/** Null when the account was deleted. */
type Author = { login: string } | null;

/** Follows `page` until a page comes back short. */
async function paginate<T>(token: string, path: string, items: (page: unknown) => T[]): Promise<T[]> {
	const perPage = 100;
	const all: T[] = [];
	for (let page = 1; ; page++) {
		const batch = items(await request(token, "GET", `${path}?per_page=${perPage}&page=${page}`));
		all.push(...batch);
		if (batch.length < perPage) return all;
	}
}

async function request<T>(token: string, method: string, path: string, body?: unknown): Promise<T> {
	const res = await fetch(`${API}${path}`, {
		method,
		headers: { ...headers(token), ...(body ? { "Content-Type": "application/json" } : {}) },
		body: body ? JSON.stringify(body) : undefined,
	});
	if (!res.ok) throw new Error(`GitHub ${method} ${path} failed: ${res.status} ${await res.text()}`);
	return res.json() as Promise<T>;
}

function headers(token: string): Record<string, string> {
	return {
		Accept: "application/vnd.github+json",
		Authorization: `Bearer ${token}`,
		"User-Agent": "quality-flare",
		"X-GitHub-Api-Version": "2022-11-28",
	};
}
