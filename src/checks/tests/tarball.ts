/**
 * Reads a GitHub tarball (gzipped tar) into a map of path → text, dropping the top-level
 * "<owner>-<repo>-<sha>/" directory GitHub adds. Only files `keep` accepts are decoded.
 */
export async function readTarball(gzipped: ReadableStream<Uint8Array>, keep: (path: string) => boolean): Promise<Map<string, string>> {
	const files = new Map<string, string>();
	await walkTarball(gzipped, (path) => (keep(path) ? (text) => files.set(path, text) : undefined));
	return files;
}

/**
 * Streams a gzipped tar, calling `visit` with each regular file's path (top-level directory
 * dropped). A file's text is decoded only when `visit` returns a callback for it, so memory
 * holds the kept files, never the whole archive. Stops early once `done` returns true.
 */
export async function walkTarball(
	gzipped: ReadableStream<Uint8Array>,
	visit: (path: string) => ((text: string) => void) | undefined,
	done: () => boolean = () => false,
): Promise<void> {
	const reader = new ByteReader(gzipped.pipeThrough(new DecompressionStream("gzip")).getReader());
	const decoder = new TextDecoder();
	let longName: string | undefined;
	try {
		while (!done()) {
			const header = await reader.read(512);
			if (!header || header.every((b) => b === 0)) break;
			const size = parseInt(field(header, 124, 12, decoder) || "0", 8);
			const padding = Math.ceil(size / 512) * 512 - size;
			const type = String.fromCharCode(header[156]);

			if (type === "x" || type === "L") {
				const body = decoder.decode(await reader.read(size));
				await reader.skip(padding);
				// PAX extended header: "<len> path=<value>\n" records for the next entry.
				longName = type === "x" ? (/(?:^|\n)\d+ path=([^\n]*)\n/.exec(body)?.[1] ?? longName) : body.replace(/\0.*$/s, "");
				continue;
			}
			const prefix = field(header, 345, 155, decoder);
			const name = longName ?? (prefix ? `${prefix}/${field(header, 0, 100, decoder)}` : field(header, 0, 100, decoder));
			longName = undefined;
			const path = name.slice(name.indexOf("/") + 1);
			const onText = (type === "0" || type === "\0") && path ? visit(path) : undefined;
			if (onText) {
				onText(decoder.decode(await reader.read(size)));
				await reader.skip(padding);
			} else {
				await reader.skip(size + padding);
			}
		}
	} finally {
		reader.cancel();
	}
}

function field(header: Uint8Array, start: number, length: number, decoder: TextDecoder): string {
	const bytes = header.subarray(start, start + length);
	const end = bytes.indexOf(0);
	return decoder.decode(end === -1 ? bytes : bytes.subarray(0, end)).trim();
}

/** Reads exact byte counts from a stream, holding only the chunks not consumed yet. */
class ByteReader {
	private chunks: Uint8Array[] = [];
	private length = 0;
	private ended = false;
	private reader: ReadableStreamDefaultReader<Uint8Array>;

	constructor(reader: ReadableStreamDefaultReader<Uint8Array>) {
		this.reader = reader;
	}

	/** The next `n` bytes, or undefined if the stream ends first. */
	async read(n: number): Promise<Uint8Array | undefined> {
		while (this.length < n && !this.ended) await this.pull();
		if (this.length < n) return undefined;
		if (!n) return new Uint8Array(0);
		const head = this.chunks[0];
		if (head.length >= n) {
			this.drop(n);
			return head.subarray(0, n);
		}
		const out = new Uint8Array(n);
		for (let filled = 0; filled < n; ) {
			const part = this.chunks[0].subarray(0, n - filled);
			out.set(part, filled);
			filled += part.length;
			this.drop(part.length);
		}
		return out;
	}

	async skip(n: number): Promise<void> {
		while (n > 0) {
			if (!this.length) {
				if (this.ended) return;
				await this.pull();
				continue;
			}
			const dropped = Math.min(n, this.chunks[0].length);
			this.drop(dropped);
			n -= dropped;
		}
	}

	cancel(): void {
		this.reader.cancel().catch(() => {});
	}

	private async pull(): Promise<void> {
		const { value, done } = await this.reader.read();
		if (done) this.ended = true;
		else if (value.length) {
			this.chunks.push(value);
			this.length += value.length;
		}
	}

	private drop(n: number): void {
		const head = this.chunks[0];
		if (n >= head.length) this.chunks.shift();
		else this.chunks[0] = head.subarray(n);
		this.length -= n;
	}
}
