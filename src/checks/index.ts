import { closesIssue } from "./closes-issue/index.ts";
import { codexReview } from "./codex-review/index.ts";
import { dependabotAutomerge } from "./dependabot-automerge/index.ts";
import { containerTests } from "./tests/container.ts";
import { tests } from "./tests/index.ts";
import type { Check, CheckResult } from "./types.ts";

/** Every check quality-flare runs on pull requests. Add new checks here. */
export const checks: Check[] = [closesIssue, tests, containerTests, dependabotAutomerge, codexReview];

/** What the Tests checks report when the deploy left them out (cloudflare.config.ts). */
export const UNAVAILABLE_RESULT: CheckResult = {
	conclusion: "neutral",
	title: "Unavailable without Workers Paid",
	summary: "This check needs Cloudflare's Workers Paid plan, and this quality-flare's account does not have it. After you subscribe, run the build again to turn it on.",
};

/**
 * The checks webhooks run. Without Workers Paid the deploy leaves the Tests checks out; they still report, as
 * neutral, so a branch protection that requires them doesn't wait forever. They stay on-demand so a run command
 * reaches one already waiting, but they never wait themselves (src/index.ts).
 */
export function checksFor(env: Pick<Env, "TESTS_OFF">): Check[] {
	if (!testsOff(env)) return checks;
	return checks.map((c) => (unavailable(c) ? { ...c, run: async () => UNAVAILABLE_RESULT } : c));
}

/** The checks the admin offers: none that this deployment can't run. */
export function adminChecksFor(env: Pick<Env, "TESTS_OFF">): Check[] {
	return testsOff(env) ? checks.filter((c) => !unavailable(c)) : checks;
}

/** Whether the deploy left the Tests checks out because the account has no Workers Paid plan. */
export function testsOff(env: Pick<Env, "TESTS_OFF">): boolean {
	return Boolean(env.TESTS_OFF);
}

const unavailable = (check: Check) => check === tests || check === containerTests;
