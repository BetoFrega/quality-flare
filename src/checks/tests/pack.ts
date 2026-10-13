import type { Weights } from "./modules.ts";

export interface PackLimits {
	/** Estimated bytes of code per shard (see `Weights`). */
	bytes: number;
	/** Files per shard, whatever their size: they share module state, and a Dynamic Worker's CPU and time. */
	files: number;
	/** Bytes assumed for a file never measured, on its own: `bytes / files` by default, packing unknown files evenly. */
	unknown?: number;
}

/**
 * Groups test files into shards that fit `limits`, from the weights measured when each file last
 * ran. A shard starts at the first file left in path order and takes, one at a time, the file that
 * adds the fewest bytes to what it already loads, until the next would pass a limit. A file
 * heavier than the limit gets a shard of its own.
 */
export function packFiles(files: string[], measured: Map<string, Weights>, limits: PackLimits): string[][] {
	const unknown = limits.unknown ?? limits.bytes / limits.files;
	const sorted = [...new Set(files)].sort();
	// Origins as indexes, and each file's weights as parallel arrays: this loop runs files² times.
	const origins = new Map<string, number>();
	const weights = sorted.map((path) => {
		const entries = Object.entries(measured.get(path) ?? { [`?${path}`]: unknown });
		const ids = new Int32Array(entries.length);
		const bytes = new Float64Array(entries.length);
		entries.forEach(([origin, b], i) => {
			ids[i] = origins.get(origin) ?? origins.set(origin, origins.size).get(origin)!;
			bytes[i] = b;
		});
		return { path, ids, bytes };
	});
	const added = (loaded: Float64Array, { ids, bytes }: (typeof weights)[number]) => {
		let cost = 0;
		for (let i = 0; i < ids.length; i++) if (bytes[i] > loaded[ids[i]]) cost += bytes[i] - loaded[ids[i]];
		return cost;
	};
	const left = weights;
	const shards: string[][] = [];
	while (left.length) {
		const loaded = new Float64Array(origins.size);
		const shard: string[] = [];
		let size = 0;
		let next = 0;
		let cost = added(loaded, left[0]);
		do {
			const [file] = left.splice(next, 1);
			shard.push(file.path);
			size += cost;
			for (let i = 0; i < file.ids.length; i++) loaded[file.ids[i]] = Math.max(loaded[file.ids[i]], file.bytes[i]);
			cost = Infinity;
			for (let i = 0; i < left.length && cost > 0; i++) {
				const c = added(loaded, left[i]);
				if (c < cost) [next, cost] = [i, c];
			}
		} while (left.length && shard.length < limits.files && size + cost <= limits.bytes);
		shards.push(shard);
	}
	return shards;
}
