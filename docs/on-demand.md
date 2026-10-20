# Tests on demand

A per-repository option in the [admin](admin.md), off by default, that applies to **Tests** and **Container tests**. When it is on, a push to the pull request doesn't run those checks. Each one waits until someone with access to the repository (OWNER, MEMBER or COLLABORATOR) comments `/quality-flare run` on the pull request.

- The comment runs the current commit once and gets a 🚀. The next push waits again.
- If the commit already has a run going, the comment doesn't start another and gets a 👀.
- With the [Codex review](checks.md#codex-review) check on, the comment runs nothing while Codex is still reviewing or left unresolved suggestions, and gets a 😕.
- Leaving draft or reopening on the same commit changes nothing: the commit keeps the check run it has.
- **Re-run** also runs.
- Pull requests opened by bots, such as Dependabot's, run on every push.

The idea is that agents run tests locally all the time and only ask for the remote run at the end: after opening the pull request, fixing the reviews and getting it ready to merge, with no push after the suite is green. The waiting check's text tells the agent so.

## The waiting check

A waiting check ends as **Action required** (`action_required`), titled `Aguardando "/quality-flare run"`. It blocks merging like a failure, but it completes the check suite: a `queued` check never completed, and agents waiting for CI to finish never woke up. A waiting check that the branch requires blocks merging, auto-merge included, until someone asks for the run.

## Merges of the base

A push whose only new commit is a clean merge of the base doesn't wait again. If the pull request's previous commit passed, the merged commit is on the base, and the merge only brings files from the base exactly as they are there, with no file the pull request also changed, the new commit inherits the previous commit's green check runs (titled `Reaproveitado de <commit>`).

Any other case waits for another `/quality-flare run`: a file changed on both sides, a change of its own in the merge, a merge of another branch, a previous commit that didn't pass. A conflict the base brings in another file, such as a renamed export the pull request uses, slips through here; the daily full run on the base catches it.

## The status comment

Agents that follow a pull request only see the check as pending, so quality-flare also keeps **one status comment** on the pull request and edits it on every change instead of posting another. The comment names the commit and the state of each check:

| Situation | The comment says |
| --- | --- |
| A push to a ready pull request (or it leaves draft) and the checks wait | ⏳ waiting for `/quality-flare run`; this is where the comment is created |
| A push after a run (going, green or red) | ⏳ waiting, and that the run on the previous commit doesn't count for the new one |
| Codex is reviewing or left unresolved suggestions, with the checks waiting | ⏸️ waiting for the Codex review, with the reason |
| `/quality-flare run` while Codex blocks | ⏸️ waiting for the Codex review, and that the command ran nothing |
| The Codex review clears (conversations resolved, review finished) | ⏳ waiting for `/quality-flare run` |
| `/quality-flare run` or **Re-run** starts the run, or the commit already had one going | 🏃 running |
| The run ends | ✅ passed or ❌ failed, check by check |

Drafts don't get the comment, but an existing comment keeps being updated. The state comes from quality-flare's check runs on the commit, and the comment is only edited when its text changes.

## Only the tests that changed

With `"changed": true` in the [`container` section](configuration.md#container), each pull request runs only the test files that depend on what it changed (`vitest --changed origin/<base>`). A change to `package.json` or `package-lock.json` stands for the files that use the packages it changed. `alwaysRun` lists tests that run on every pull request anyway, such as tests that read files or run scripts, which vitest's module graph can't connect to a change.

## The daily full run

Once a day, at 09:00 UTC, every repository with `changed` on runs every test on its default branch, unless that commit already ran. This catches what affected-only runs miss. When the full run fails, quality-flare opens an issue on the repository. The full run is also the only run that writes [caches and snapshots](configuration.md#caches).
