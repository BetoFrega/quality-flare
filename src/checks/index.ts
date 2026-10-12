import { closesIssue } from "./closes-issue/index.ts";
import { dependabotAutomerge } from "./dependabot-automerge/index.ts";
import { tests } from "./tests/index.ts";
import type { Check } from "./types.ts";

/** Every check quality-flare runs on pull requests. Add new checks here. */
export const checks: Check[] = [closesIssue, tests, dependabotAutomerge];
