import { describe, expect, it } from "vitest";
import { getRepoSettings, setChecksEnabled, setOnDemand, setRepoEnabled } from "../src/settings.ts";
import { fakeKv } from "./fake-kv.ts";

describe("repository settings", () => {
	it("starts with the repository and every check off", async () => {
		expect(await getRepoSettings(fakeKv(), "octo/repo")).toEqual({ enabled: false, enabledChecks: new Set(), onDemand: false });
	});

	it("treats settings saved before checks were opt-in as all off", async () => {
		const kv = fakeKv();
		await kv.put("repo:octo/repo", JSON.stringify({ disabledChecks: ["closes-issue"] }));
		expect(await getRepoSettings(kv, "octo/repo")).toEqual({ enabled: false, enabledChecks: new Set(), onDemand: false });
	});

	it("turns the repository and its checks on and off independently, ignoring name case", async () => {
		const kv = fakeKv();
		await setRepoEnabled(kv, "Octo/Repo", true);
		await setChecksEnabled(kv, "octo/repo", ["a", "b"], true);
		await setChecksEnabled(kv, "octo/repo", ["a"], false);
		expect(await getRepoSettings(kv, "OCTO/repo")).toEqual({ enabled: true, enabledChecks: new Set(["b"]), onDemand: false });
		await setRepoEnabled(kv, "octo/repo", false);
		expect(await getRepoSettings(kv, "octo/repo")).toEqual({ enabled: false, enabledChecks: new Set(["b"]), onDemand: false });
	});

	it("keeps tests on demand off until it is turned on", async () => {
		const kv = fakeKv();
		await setOnDemand(kv, "octo/repo", true);
		expect((await getRepoSettings(kv, "octo/repo")).onDemand).toBe(true);
		await setChecksEnabled(kv, "octo/repo", ["a"], true);
		expect((await getRepoSettings(kv, "octo/repo")).onDemand).toBe(true);
		await setOnDemand(kv, "octo/repo", false);
		expect(await kv.get("repo:octo/repo")).toBe(JSON.stringify({ enabled: false, enabledChecks: ["a"] }));
	});
});
