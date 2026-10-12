/**
 * Per-repository check settings, stored in Workers KV under `repo:<owner/repo>`.
 * Checks are enabled unless a repository's settings list them as disabled.
 */
interface RepoSettings {
	/** Ids of the checks turned off for this repository. */
	disabledChecks: string[];
}

const key = (repo: string) => `repo:${repo.toLowerCase()}`;

export async function getDisabledChecks(kv: KVNamespace, repo: string): Promise<Set<string>> {
	const settings = await kv.get<RepoSettings>(key(repo), "json");
	return new Set(settings?.disabledChecks ?? []);
}

export async function setCheckEnabled(kv: KVNamespace, repo: string, checkId: string, enabled: boolean): Promise<void> {
	const disabled = await getDisabledChecks(kv, repo);
	if (enabled) disabled.delete(checkId);
	else disabled.add(checkId);
	const settings: RepoSettings = { disabledChecks: [...disabled].sort() };
	await kv.put(key(repo), JSON.stringify(settings));
}
