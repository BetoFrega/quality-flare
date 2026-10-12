import { describe, expect, it } from "vitest";
import { getDisabledChecks, setCheckEnabled } from "../src/settings.ts";
import { fakeKv } from "./fake-kv.ts";

describe("repository settings", () => {
	it("enables every check by default", async () => {
		expect(await getDisabledChecks(fakeKv(), "octo/repo")).toEqual(new Set());
	});

	it("turns a check off and back on, ignoring repository name case", async () => {
		const kv = fakeKv();
		await setCheckEnabled(kv, "Octo/Repo", "closes-issue", false);
		expect(await getDisabledChecks(kv, "octo/repo")).toEqual(new Set(["closes-issue"]));
		await setCheckEnabled(kv, "octo/repo", "closes-issue", true);
		expect(await getDisabledChecks(kv, "Octo/Repo")).toEqual(new Set());
	});
});
