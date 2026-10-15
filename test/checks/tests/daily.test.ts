import { describe, expect, it, vi } from "vitest";
import type { RunTarget } from "../../../src/checks/tests/container.ts";
import { runDailyFullRuns } from "../../../src/checks/tests/daily.ts";
import type { GitHubClient } from "../../../src/github.ts";
import { d1RunStore } from "../../../src/runs.ts";
import { setChecksEnabled, setRepoEnabled } from "../../../src/settings.ts";
import { fakeD1 } from "../../fake-d1.ts";
import { fakeKv } from "../../fake-kv.ts";

// fakeD1 needs Node's sqlite, which the Workers runtime (quality-flare's own Tests check) doesn't have.
const inWorkers = globalThis.navigator?.userAgent === "Cloudflare-Workers";

describe.skipIf(inWorkers)("daily full run", () => {
	async function setup(configs: Record<string, unknown>) {
		const env = { RUNS: await fakeD1(), SETTINGS: fakeKv() } as unknown as Env;
		for (const repo of ["octo/changed", "octo/whole", "octo/off"]) await setRepoEnabled(env.SETTINGS, repo, true);
		await setChecksEnabled(env.SETTINGS, "octo/changed", ["container-tests"], true);
		await setChecksEnabled(env.SETTINGS, "octo/whole", ["container-tests"], true);
		const github = {
			branchHead: async (repo: string, branch: string) => `${repo}@${branch}`,
			getFileText: async (repo: string) => (configs[repo] === undefined ? undefined : JSON.stringify(configs[repo])),
		} as unknown as GitHubClient;
		const start = vi.fn(async (_target: RunTarget) => null);
		const repos = ["octo/changed", "octo/whole", "octo/off", "octo/broken"].map((repo) => ({ installationId: 9, repo, defaultBranch: "trunk" }));
		return { env, start, deps: { repos: async () => repos, github: async () => github, start } };
	}

	it("runs everything on the default branch of the repositories that run only the affected tests on PRs", async () => {
		const { env, start, deps } = await setup({
			"octo/changed": { container: { changed: true } },
			"octo/whole": { container: {} },
			"octo/off": { container: { changed: true } },
		});
		await runDailyFullRuns(env, deps);
		expect(start).toHaveBeenCalledTimes(1);
		const target = start.mock.calls[0][0];
		expect(target).toMatchObject({ repo: "octo/changed", pr: 0, sha: "octo/changed@trunk", base: "trunk", full: true, installationId: 9 });
		expect(await target.config()).toEqual({ changed: true });
	});

	it("doesn't run the same commit twice, and an invalid config skips only its repository", async () => {
		const { env, start, deps } = await setup({ "octo/changed": { container: { changed: true } }, "octo/whole": { container: { changed: "yes" } } });
		await d1RunStore(env.RUNS).start({ repo: "octo/changed", pr: 0, sha: "octo/changed@trunk", container: true });
		await runDailyFullRuns(env, deps);
		expect(start).not.toHaveBeenCalled();
	});
});
