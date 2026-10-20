import { closesIssue } from "./closes-issue/index.ts";
import { codexReview } from "./codex-review/index.ts";
import { dependabotAutomerge } from "./dependabot-automerge/index.ts";
import { containerTests } from "./tests/container.ts";
import { tests } from "./tests/index.ts";
import type { Check } from "./types.ts";

/** Every check quality-flare runs on pull requests. Add new checks here. */
export const checks: Check[] = [closesIssue, tests, containerTests, dependabotAutomerge, codexReview];

/** The checks this deployment can run: without Workers Paid the deploy leaves the Tests checks out (cloudflare.config.ts). */
export function checksFor(env: Pick<Env, "TESTS_OFF">): Check[] {
	return testsOff(env) ? checks.filter((c) => c !== tests && c !== containerTests) : checks;
}

/** Whether the deploy left the Tests checks out because the account has no Workers Paid plan. */
export function testsOff(env: Pick<Env, "TESTS_OFF">): boolean {
	return Boolean(env.TESTS_OFF);
}
