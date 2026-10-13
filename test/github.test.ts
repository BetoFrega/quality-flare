import { afterEach, describe, expect, it, vi } from "vitest";
import { GitHubClient } from "../src/github.ts";

afterEach(() => vi.unstubAllGlobals());

describe("createCheckRun", () => {
	function capture() {
		const bodies: Record<string, unknown>[] = [];
		vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
			bodies.push(JSON.parse(init.body as string));
			return Response.json({ id: 1 }, { status: 201 });
		});
		return bodies;
	}

	it("completes the check run with the conclusion", async () => {
		const bodies = capture();
		await new GitHubClient("t").createCheckRun("o/r", "abc", "X", { conclusion: "failure", title: "t", summary: "s" });
		expect(bodies[0]).toMatchObject({ status: "completed", conclusion: "failure" });
	});

	it("leaves a pending result in progress, without a conclusion", async () => {
		const bodies = capture();
		await new GitHubClient("t").createCheckRun("o/r", "abc", "X", { conclusion: "pending", title: "t", summary: "s" });
		expect(bodies[0]).toMatchObject({ status: "in_progress", output: { title: "t", summary: "s" } });
		expect(bodies[0]).not.toHaveProperty("conclusion");
	});
});
