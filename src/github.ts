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

export interface PullRequest {
	number: number;
	body: string | null;
	head: { sha: string };
	labels: { name: string }[];
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
		headers: {
			Accept: "application/vnd.github+json",
			Authorization: `Bearer ${token}`,
			"User-Agent": "quality-flare",
			"X-GitHub-Api-Version": "2022-11-28",
			...(body ? { "Content-Type": "application/json" } : {}),
		},
		body: body ? JSON.stringify(body) : undefined,
	});
	if (!res.ok) throw new Error(`GitHub ${method} ${path} failed: ${res.status} ${await res.text()}`);
	return res.json() as Promise<T>;
}
