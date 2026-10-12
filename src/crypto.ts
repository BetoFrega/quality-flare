const encoder = new TextEncoder();

/** Verifies GitHub's `X-Hub-Signature-256` header against the raw body. */
export async function verifySignature(secret: string, body: string, header: string | null): Promise<boolean> {
	if (!header?.startsWith("sha256=")) return false;
	const signature = hexToBytes(header.slice("sha256=".length));
	if (!signature) return false;
	const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
		"verify",
	]);
	// subtle.verify compares in constant time.
	return crypto.subtle.verify("HMAC", key, signature, encoder.encode(body));
}

/** Creates a GitHub App JWT (RS256), valid for 9 minutes. */
export async function createAppJwt(appId: string, privateKeyPem: string, now = Date.now()): Promise<string> {
	const iat = Math.floor(now / 1000) - 60;
	const header = base64url(encoder.encode(JSON.stringify({ alg: "RS256", typ: "JWT" })));
	const payload = base64url(encoder.encode(JSON.stringify({ iat, exp: iat + 600, iss: appId })));
	const key = await crypto.subtle.importKey(
		"pkcs8",
		pemToPkcs8(privateKeyPem),
		{ name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
		false,
		["sign"],
	);
	const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, encoder.encode(`${header}.${payload}`));
	return `${header}.${payload}.${base64url(new Uint8Array(signature))}`;
}

/**
 * GitHub hands out PKCS#1 keys ("BEGIN RSA PRIVATE KEY") but WebCrypto only
 * imports PKCS#8, so PKCS#1 keys are wrapped in a PKCS#8 envelope here.
 */
export function pemToPkcs8(pem: string): Uint8Array<ArrayBuffer> {
	// Secrets pasted through some UIs arrive with literal "\n" sequences.
	const normalized = pem.replace(/\\n/g, "\n").trim();
	const der = base64ToBytes(normalized.replace(/-----(BEGIN|END) [A-Z ]+-----/g, "").replace(/\s+/g, ""));
	if (normalized.includes("BEGIN PRIVATE KEY")) return der;
	if (!normalized.includes("BEGIN RSA PRIVATE KEY")) throw new Error("Unsupported private key format");
	// SEQUENCE { INTEGER 0, SEQUENCE { OID rsaEncryption, NULL }, OCTET STRING { pkcs1 } }
	const version = Uint8Array.of(0x02, 0x01, 0x00);
	const algorithm = Uint8Array.of(0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00);
	return derSequence(0x30, concat(version, algorithm, derSequence(0x04, der)));
}

function derSequence(tag: number, content: Uint8Array): Uint8Array<ArrayBuffer> {
	const len = content.length;
	let lengthBytes: Uint8Array;
	if (len < 0x80) {
		lengthBytes = Uint8Array.of(len);
	} else {
		const bytes: number[] = [];
		for (let n = len; n > 0; n >>= 8) bytes.unshift(n & 0xff);
		lengthBytes = Uint8Array.of(0x80 | bytes.length, ...bytes);
	}
	return concat(Uint8Array.of(tag), lengthBytes, content);
}

function concat(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
	const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
	let offset = 0;
	for (const p of parts) {
		out.set(p, offset);
		offset += p.length;
	}
	return out;
}

function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
	const bin = atob(b64);
	const out = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
	return out;
}

function base64url(bytes: Uint8Array): string {
	let bin = "";
	for (const b of bytes) bin += String.fromCharCode(b);
	return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function hexToBytes(hex: string): Uint8Array<ArrayBuffer> | null {
	if (hex.length % 2 !== 0 || !/^[0-9a-f]*$/i.test(hex)) return null;
	const out = new Uint8Array(hex.length / 2);
	for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
	return out;
}
