/** In-memory stand-in for the parts of KVNamespace the Worker uses. */
export function fakeKv(): KVNamespace {
	const store = new Map<string, string>();
	return {
		async get(key: string, type?: string) {
			const value = store.get(key) ?? null;
			return value !== null && type === "json" ? JSON.parse(value) : value;
		},
		async put(key: string, value: string) {
			store.set(key, value);
		},
	} as unknown as KVNamespace;
}
