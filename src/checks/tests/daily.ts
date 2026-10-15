import { GitHubClient, type InstallationRepo } from "../../github.ts";
import { d1RunStore } from "../../runs.ts";
import { getRepoSettings } from "../../settings.ts";
import { CONFIG_FILE, readContainerConfig } from "./config.ts";
import { containerTests, startRun, type RunTarget } from "./container.ts";

/**
 * The daily full run. A repository whose config sets `container.changed` runs, on each PR, only the
 * tests that depend on what the PR changed; once a day its default branch runs everything, so what
 * that left out (a test that reads a file it doesn't import, say) still fails somewhere. A failure
 * opens an issue (alertFullRun).
 */

/** 09:00 UTC, 06:00 in Brasília: before the day's PRs. */
export const DAILY_CRON = "0 9 * * *";

export interface DailyDeps {
	repos(): Promise<InstallationRepo[]>;
	github(installationId: number): Promise<GitHubClient>;
	start(target: RunTarget): Promise<unknown>;
}

/** Starts a full run on the default branch of each repository that runs only the affected tests, unless its head already had one. */
export async function runDailyFullRuns(env: Env, deps: DailyDeps = liveDeps(env)): Promise<void> {
	const runs = d1RunStore(env.RUNS);
	for (const { installationId, repo, defaultBranch } of await deps.repos()) {
		try {
			const settings = await getRepoSettings(env.SETTINGS, repo);
			if (!settings.enabled || !settings.enabledChecks.has(containerTests.id)) continue;
			const github = await deps.github(installationId);
			const sha = await github.branchHead(repo, defaultBranch);
			const config = readContainerConfig(await github.getFileText(repo, sha, CONFIG_FILE));
			if (!config.changed || (await runs.ran(repo, 0, sha))) continue;
			await deps.start({ github, env, installationId, repo, pr: 0, sha, base: defaultBranch, full: true, config: async () => config });
		} catch (error) {
			console.error(`quality-flare: daily full run of ${repo}`, error);
		}
	}
}

function liveDeps(env: Env): DailyDeps {
	const creds = { appId: env.GITHUB_APP_ID, privateKey: env.GITHUB_PRIVATE_KEY };
	return {
		repos: () => GitHubClient.listInstallationRepos(creds),
		github: (installationId) => GitHubClient.forInstallation(creds, installationId),
		start: startRun,
	};
}
