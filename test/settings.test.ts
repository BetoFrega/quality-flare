import { describe, expect, it } from "vitest";
import { getRepoSettings, setChecksEnabled, setRepoEnabled } from "../src/settings.ts";
import { fakeKv } from "./fake-kv.ts";

describe("repository settings", () => {
	it("starts with the repository and every check off", async () => {
		expect(await getRepoSettings(fakeKv(), "octo/repo")).toEqual({ enabled: false, enabledChecks: new Set() });
	});

	it("treats settings saved before checks were opt-in as all off", async () => {
		const kv = fakeKv();
		await kv.put("repo:octo/repo", JSON.stringify({ disabledChecks: ["closes-issue"] }));
		expect(await getRepoSettings(kv, "octo/repo")).toEqual({ enabled: false, enabledChecks: new Set() });
	});

	it("turns the repository and its checks on and off independently, ignoring name case", async () => {
		const kv = fakeKv();
		await setRepoEnabled(kv, "Octo/Repo", true);
		await setChecksEnabled(kv, "octo/repo", ["a", "b"], true);
		await setChecksEnabled(kv, "octo/repo", ["a"], false);
		expect(await getRepoSettings(kv, "OCTO/repo")).toEqual({ enabled: true, enabledChecks: new Set(["b"]) });
		await setRepoEnabled(kv, "octo/repo", false);
		expect(await getRepoSettings(kv, "octo/repo")).toEqual({ enabled: false, enabledChecks: new Set(["b"]) });
	});
});
