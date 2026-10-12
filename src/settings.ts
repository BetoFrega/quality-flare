/**
 * Per-repository settings, stored in Workers KV under `repo:<owner/repo>`.
 * Everything starts off: a repository runs nothing until it is enabled, and
 * then only the checks that were turned on for it.
 */
export interface RepoSettings {
	enabled: boolean;
	/** Ids of the checks turned on for this repository. */
	enabledChecks: Set<string>;
}

interface StoredSettings {
	enabled?: boolean;
	enabledChecks?: string[];
}

const key = (repo: string) => `repo:${repo.toLowerCase()}`;

export async function getRepoSettings(kv: KVNamespace, repo: string): Promise<RepoSettings> {
	const stored = await kv.get<StoredSettings>(key(repo), "json");
	return { enabled: stored?.enabled ?? false, enabledChecks: new Set(stored?.enabledChecks ?? []) };
}

async function update(kv: KVNamespace, repo: string, change: (settings: RepoSettings) => void): Promise<void> {
	const settings = await getRepoSettings(kv, repo);
	change(settings);
	const stored: StoredSettings = { enabled: settings.enabled, enabledChecks: [...settings.enabledChecks].sort() };
	await kv.put(key(repo), JSON.stringify(stored));
}

export function setRepoEnabled(kv: KVNamespace, repo: string, enabled: boolean): Promise<void> {
	return update(kv, repo, (s) => {
		s.enabled = enabled;
	});
}

export function setChecksEnabled(kv: KVNamespace, repo: string, checkIds: string[], enabled: boolean): Promise<void> {
	return update(kv, repo, (s) => {
		for (const id of checkIds) {
			if (enabled) s.enabledChecks.add(id);
			else s.enabledChecks.delete(id);
		}
	});
}
