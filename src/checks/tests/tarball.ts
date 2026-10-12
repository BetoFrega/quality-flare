/**
 * Reads a GitHub tarball (gzipped tar) into a map of path → text, dropping the top-level
 * "<owner>-<repo>-<sha>/" directory GitHub adds. Only files `keep` accepts are decoded.
 */
export async function readTarball(gzipped: ReadableStream<Uint8Array>, keep: (path: string) => boolean): Promise<Map<string, string>> {
	const tar = new Uint8Array(await new Response(gzipped.pipeThrough(new DecompressionStream("gzip"))).arrayBuffer());
	const files = new Map<string, string>();
	const decoder = new TextDecoder();
	let longName: string | undefined;
	for (let offset = 0; offset + 512 <= tar.length; ) {
		const header = tar.subarray(offset, offset + 512);
		if (header.every((b) => b === 0)) break;
		const size = parseInt(field(header, 124, 12, decoder) || "0", 8);
		const type = String.fromCharCode(header[156]);
		const body = tar.subarray(offset + 512, offset + 512 + size);
		offset += 512 + Math.ceil(size / 512) * 512;

		if (type === "x") {
			// PAX extended header: "<len> path=<value>\n" records for the next entry.
			longName = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(decoder.decode(body))?.[1] ?? longName;
			continue;
		}
		if (type === "L") {
			longName = decoder.decode(body).replace(/\0.*$/s, "");
			continue;
		}
		const prefix = field(header, 345, 155, decoder);
		const name = longName ?? (prefix ? `${prefix}/${field(header, 0, 100, decoder)}` : field(header, 0, 100, decoder));
		longName = undefined;
		if (type !== "0" && type !== "\0") continue;
		const path = name.slice(name.indexOf("/") + 1);
		if (path && keep(path)) files.set(path, decoder.decode(body));
	}
	return files;
}

function field(header: Uint8Array, start: number, length: number, decoder: TextDecoder): string {
	const bytes = header.subarray(start, start + length);
	const end = bytes.indexOf(0);
	return decoder.decode(end === -1 ? bytes : bytes.subarray(0, end)).trim();
}
