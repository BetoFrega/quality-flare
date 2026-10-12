/** Builds a gzipped tarball the way GitHub serves one: everything under "<owner>-<repo>-<sha>/". */
export function tarball(files: Record<string, string>, root = "octo-repo-abc123"): ReadableStream<Uint8Array> {
	const encoder = new TextEncoder();
	const blocks: Uint8Array[] = [];
	const entry = (name: string, body: Uint8Array, type: string) => {
		const header = new Uint8Array(512);
		const write = (text: string, offset: number) => header.set(encoder.encode(text), offset);
		write(name.slice(0, 100), 0);
		write("0000644\0", 100);
		write(`${body.length.toString(8).padStart(11, "0")}\0`, 124);
		write(" ".repeat(8), 148);
		write(type, 156);
		write("ustar\0" + "00", 257);
		const checksum = header.reduce((sum, b) => sum + b, 0);
		write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148);
		blocks.push(header, body, new Uint8Array((512 - (body.length % 512)) % 512));
	};
	entry("pax_global_header", encoder.encode("52 comment=abc123\n"), "g");
	for (const [path, content] of Object.entries(files)) {
		const name = `${root}/${path}`;
		if (name.length > 100) {
			const record = ` path=${name}\n`;
			const len = String(record.length + String(record.length).length);
			entry("PaxHeader", encoder.encode(`${len}${record}`), "x");
		}
		entry(name, encoder.encode(content), "0");
	}
	blocks.push(new Uint8Array(1024));
	return new Blob(blocks).stream().pipeThrough(new CompressionStream("gzip"));
}
