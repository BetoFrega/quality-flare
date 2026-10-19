import { describe, expect, it } from "vitest";
import { FILES_PREFIX, handleTurboCache, tokenRepo, turboToken } from "../src/turbo-cache.ts";

/** The parts of R2Bucket the cache uses, in memory. */
function fakeR2(): R2Bucket {
	const store = new Map<string, { bytes: Uint8Array; customMetadata: Record<string, string> }>();
	const meta = (key: string) => {
		const o = store.get(key);
		return o && { key, size: o.bytes.length, customMetadata: o.customMetadata };
	};
	return {
		async put(key: string, body: ReadableStream, options: { customMetadata: Record<string, string> }) {
			store.set(key, { bytes: new Uint8Array(await new Response(body).arrayBuffer()), customMetadata: options.customMetadata });
		},
		async head(key: string) {
			return meta(key) ?? null;
		},
		async get(key: string) {
			const m = meta(key);
			return m ? { ...m, body: new Response(store.get(key)!.bytes).body } : null;
		},
	} as unknown as R2Bucket;
}

const SECRET = "webhook-secret";

describe("Turborepo remote cache", () => {
	it("gives each repository a token that names it and nothing else", async () => {
		const token = await turboToken(SECRET, "octo/app");
		expect(await tokenRepo(SECRET, token)).toBe("octo/app");
		expect(await tokenRepo("other-secret", token)).toBeUndefined();
		const [, mac] = token.split(".");
		const forged = `${btoa("octo/other").replace(/=+$/, "")}.${mac}`;
		expect(await tokenRepo(SECRET, forged)).toBeUndefined();
	});

	it("stores and serves artifacts with their duration, only to the repository that wrote them", async () => {
		const bucket = fakeR2();
		const call = async (repo: string, method: string, path: string, init: RequestInit = {}) =>
			handleTurboCache(
				new Request(`https://qf.example/turbo${path}`, { method, ...init, headers: { Authorization: `Bearer ${await turboToken(SECRET, repo)}`, ...init.headers } }),
				bucket,
				SECRET,
			);

		expect(await (await call("octo/app", "GET", "/v8/artifacts/status")).json()).toEqual({ status: "enabled" });
		expect((await call("octo/app", "GET", "/v8/artifacts/abc123")).status).toBe(404);
		const put = await call("octo/app", "PUT", "/v8/artifacts/abc123?slug=quality-flare", { body: "tarball", headers: { "x-artifact-duration": "4200" } });
		expect(put.status).toBe(202);

		const hit = await call("octo/app", "GET", "/v8/artifacts/abc123?slug=quality-flare");
		expect(hit.status).toBe(200);
		expect(hit.headers.get("x-artifact-duration")).toBe("4200");
		expect(await hit.text()).toBe("tarball");
		expect((await call("octo/app", "HEAD", "/v8/artifacts/abc123")).status).toBe(200);
		expect(await (await call("octo/app", "POST", "/v8/artifacts", { body: JSON.stringify({ hashes: ["abc123", "zzz"] }) })).json()).toEqual({
			abc123: { size: 7, taskDurationMs: 4200 },
			zzz: null,
		});
		// Another repository's token doesn't reach it.
		expect((await call("octo/other", "GET", "/v8/artifacts/abc123")).status).toBe(404);
	});

	it("lets a read-only token read its repository's artifacts but not write them, and only a files token write the file cache", async () => {
		const bucket = fakeR2();
		const request = (token: string, method: string, hash: string, body?: string) =>
			handleTurboCache(new Request(`https://qf.example/turbo/v8/artifacts/${hash}`, { method, body, headers: { Authorization: `Bearer ${token}` } }), bucket, SECRET);
		const reader = await turboToken(SECRET, "octo/app", "read");
		const writer = await turboToken(SECRET, "octo/app");
		const files = await turboToken(SECRET, "octo/app", "files");
		expect(await tokenRepo(SECRET, reader)).toBe("octo/app");
		expect((await request(reader, "PUT", "abc123", "forged")).status).toBe(403);
		expect((await request(writer, "PUT", "abc123", "tarball")).status).toBe(202);
		expect(await (await request(reader, "GET", "abc123")).text()).toBe("tarball");
		// The file cache: PR runs hold the default kind as TURBO_TOKEN, and it doesn't write there.
		expect((await request(writer, "PUT", `${FILES_PREFIX}k`, "forged")).status).toBe(403);
		expect((await request(files, "PUT", `${FILES_PREFIX}k`, "files")).status).toBe(202);
		expect(await (await request(reader, "GET", `${FILES_PREFIX}k`)).text()).toBe("files");
		// Dropping or swapping the letter doesn't change the kind: each is signed apart.
		const [name, , mac] = reader.split(".");
		expect(await tokenRepo(SECRET, `${name}.${mac}`)).toBeUndefined();
		expect(await tokenRepo(SECRET, `${name}.f.${mac}`)).toBeUndefined();
	});

	it("refuses requests without a valid token, and keys that aren't hashes", async () => {
		const bucket = fakeR2();
		const res = await handleTurboCache(new Request("https://qf.example/turbo/v8/artifacts/abc", { headers: { Authorization: "Bearer nope" } }), bucket, SECRET);
		expect(res.status).toBe(403);
		const token = await turboToken(SECRET, "octo/app");
		const odd = await handleTurboCache(new Request("https://qf.example/turbo/v8/artifacts/..%2Fx", { headers: { Authorization: `Bearer ${token}` } }), bucket, SECRET);
		expect(odd.status).toBe(404);
	});
});
