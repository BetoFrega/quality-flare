import { createHmac, createVerify, generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createAppJwt, verifySignature } from "../src/crypto.ts";

describe("verifySignature", () => {
	const body = '{"hello":"world"}';
	const sign = (secret: string) => `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;

	it("accepts a valid signature", async () => {
		expect(await verifySignature("s3cret", body, sign("s3cret"))).toBe(true);
	});

	it.each([[null], [""], ["sha1=abc"], ["sha256=zz"], ["sha256=00"]])("rejects %j", async (header) => {
		expect(await verifySignature("s3cret", body, header)).toBe(false);
	});

	it("rejects a signature made with another secret", async () => {
		expect(await verifySignature("s3cret", body, sign("other"))).toBe(false);
	});
});

describe("createAppJwt", () => {
	const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });

	it.each([
		["PKCS#1", privateKey.export({ type: "pkcs1", format: "pem" }).toString()],
		["PKCS#8", privateKey.export({ type: "pkcs8", format: "pem" }).toString()],
		["PKCS#1 with escaped newlines", privateKey.export({ type: "pkcs1", format: "pem" }).toString().replace(/\n/g, "\\n")],
	])("signs a verifiable RS256 token from a %s key", async (_, pem) => {
		const now = Date.UTC(2026, 0, 1);
		const jwt = await createAppJwt("12345", pem, now);
		const [header, payload, signature] = jwt.split(".");

		const verifier = createVerify("RSA-SHA256");
		verifier.update(`${header}.${payload}`);
		expect(verifier.verify(publicKey, Buffer.from(signature, "base64url"))).toBe(true);

		expect(JSON.parse(Buffer.from(header, "base64url").toString())).toEqual({ alg: "RS256", typ: "JWT" });
		const iat = now / 1000 - 60;
		expect(JSON.parse(Buffer.from(payload, "base64url").toString())).toEqual({ iat, exp: iat + 600, iss: "12345" });
	});
});
