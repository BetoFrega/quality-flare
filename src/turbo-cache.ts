/**
 * A Turborepo remote cache (https://turborepo.com/docs/core-concepts/remote-caching) on R2, for
 * Container tests runs whose config sets `container.turboCache`: the container gets TURBO_API,
 * TURBO_TEAM and a TURBO_TOKEN that reaches only its repository's artifacts, so a task whose inputs
 * an earlier run already built (a PR's second run, a package the PR didn't touch) comes from the
 * cache instead of running again. The bucket's lifecycle rule expires artifacts nobody wrote lately.
 *
 * The token is the repository plus an HMAC of it under the webhook secret, so it needs no storage
 * and a token one repository's code can read never opens another's artifacts. A read-only token
 * (an "r" between the two, signed apart) can't write: for runs whose code mustn't fill a cache
 * later runs trust.
 */

export const TURBO_PATH = "/turbo";

/** Turborepo's hashes are hex; anything else is not a key of ours. */
const HASH = /^[A-Za-z0-9_-]{1,128}$/;

const encoder = new TextEncoder();

/** The token a repository's container runs get. */
export async function turboToken(secret: string, repo: string, readOnly = false): Promise<string> {
	const mac = b64(await sign(secret, scope(repo, readOnly)));
	return readOnly ? `${b64(encoder.encode(repo))}.r.${mac}` : `${b64(encoder.encode(repo))}.${mac}`;
}

/** The repository a token was made for and whether it may write, or undefined when it isn't one of ours. */
export async function tokenAccess(secret: string, token: string): Promise<{ repo: string; write: boolean } | undefined> {
	const parts = token.split(".");
	const readOnly = parts.length === 3 && parts[1] === "r";
	const [name, mac] = readOnly ? [parts[0], parts[2]] : parts.length === 2 ? parts : [];
	if (!name || !mac) return undefined;
	const repo = new TextDecoder().decode(unb64(name));
	const valid = await crypto.subtle.verify("HMAC", await hmacKey(secret), unb64(mac), encoder.encode(scope(repo, readOnly)));
	return valid ? { repo, write: !readOnly } : undefined;
}

/** The repository a token was made for, or undefined when it isn't one of ours. */
export async function tokenRepo(secret: string, token: string): Promise<string | undefined> {
	return (await tokenAccess(secret, token))?.repo;
}

/** Answers Turborepo's remote cache API under TURBO_PATH: artifacts by hash, scoped to the token's repository. */
export async function handleTurboCache(request: Request, bucket: R2Bucket, secret: string): Promise<Response> {
	const path = new URL(request.url).pathname.slice(TURBO_PATH.length);
	const auth = request.headers.get("Authorization") ?? "";
	const access = auth.startsWith("Bearer ") ? await tokenAccess(secret, auth.slice("Bearer ".length)).catch(() => undefined) : undefined;
	if (!access) return Response.json({ error: { code: "forbidden", message: "Token inválido" } }, { status: 403 });
	const { repo } = access;

	if (path === "/v8/artifacts/status") return Response.json({ status: "enabled" });
	// Usage events: nothing to keep.
	if (path === "/v8/artifacts/events") return new Response(null, { status: 200 });
	if (path === "/v8/artifacts" && request.method === "POST") {
		const { hashes = [] } = (await request.json()) as { hashes?: string[] };
		const found = await Promise.all(hashes.filter((h) => HASH.test(h)).map(async (h) => [h, await bucket.head(key(repo, h))] as const));
		return Response.json(Object.fromEntries(found.map(([h, o]) => [h, o ? { size: o.size, taskDurationMs: Number(o.customMetadata?.duration ?? 0), tag: o.customMetadata?.tag } : null])));
	}

	const hash = path.match(/^\/v8\/artifacts\/([^/]+)$/)?.[1];
	if (!hash || !HASH.test(hash)) return new Response("Not found", { status: 404 });
	switch (request.method) {
		case "PUT": {
			if (!access.write) return Response.json({ error: { code: "forbidden", message: "Token só de leitura" } }, { status: 403 });
			if (!request.body) return new Response("Missing body", { status: 400 });
			const customMetadata: Record<string, string> = { duration: request.headers.get("x-artifact-duration") ?? "0" };
			const tag = request.headers.get("x-artifact-tag");
			if (tag) customMetadata.tag = tag;
			await bucket.put(key(repo, hash), request.body, { customMetadata });
			return Response.json({ urls: [] }, { status: 202 });
		}
		case "HEAD":
		case "GET": {
			const object = request.method === "GET" ? await bucket.get(key(repo, hash)) : await bucket.head(key(repo, hash));
			if (!object) return new Response(null, { status: 404 });
			const headers = new Headers({ "Content-Type": "application/octet-stream", "Content-Length": String(object.size), "x-artifact-duration": object.customMetadata?.duration ?? "0" });
			if (object.customMetadata?.tag) headers.set("x-artifact-tag", object.customMetadata.tag);
			return new Response(request.method === "GET" ? (object as R2ObjectBody).body : null, { headers });
		}
		default:
			return new Response("Method not allowed", { status: 405 });
	}
}

function key(repo: string, hash: string): string {
	return `${repo.toLowerCase()}/${hash}`;
}

function scope(repo: string, readOnly: boolean): string {
	return `${readOnly ? "turbo-cache-read" : "turbo-cache"}:${repo}`;
}

async function sign(secret: string, message: string): Promise<Uint8Array> {
	return new Uint8Array(await crypto.subtle.sign("HMAC", await hmacKey(secret), encoder.encode(message)));
}

function hmacKey(secret: string): Promise<CryptoKey> {
	return crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

function b64(bytes: Uint8Array): string {
	return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function unb64(text: string): Uint8Array<ArrayBuffer> {
	const bin = atob(text.replaceAll("-", "+").replaceAll("_", "/"));
	return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}
