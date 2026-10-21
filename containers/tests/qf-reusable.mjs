#!/usr/bin/env node
// qf-reusable: exits 0 when a later Container tests run may reuse this repository's install (the snapshot,
// the skipped install, the file cache), whose key hashes only the lockfile, the package.json files and the
// package managers' config (qf-run.sh). That holds when what the install writes to node_modules follows from
// those files alone:
// - npm with a package-lock.json (`npm ci --ignore-scripts`); pnpm and Yarn can run code at install time
//   (pnpmfiles, yarnPath, plugins) or copy repository files into node_modules (injected workspace packages);
// - and every package in it pinned by an integrity hash, or a link to a directory of the repository, which
//   node_modules points to instead of copying. A directory packed into node_modules (install-links) or a git
//   dependency has no hash, so its contents could change without the key changing.
// Why not goes to stderr.
import { existsSync, readFileSync } from "node:fs";

function fail(reason) {
	console.error(`Install cannot be reused: ${reason}.`);
	process.exit(1);
}

for (const other of ["pnpm-lock.yaml", "yarn.lock", ".yarnrc", ".yarnrc.yml"]) if (existsSync(other)) fail(`has ${other}`);
// npm prefers npm-shrinkwrap.json when both exist; qf-run.sh's `npm ci` needs package-lock.json.
if (!existsSync("package-lock.json")) fail("no package-lock.json");
const lockfile = existsSync("npm-shrinkwrap.json") ? "npm-shrinkwrap.json" : "package-lock.json";
let packages;
try {
	packages = JSON.parse(readFileSync(lockfile, "utf8")).packages;
} catch {
	fail(`${lockfile} is unreadable`);
}
if (!packages || typeof packages !== "object") fail(`${lockfile} has no "packages" (lockfileVersion 1)`);
for (const [path, entry] of Object.entries(packages)) {
	if (path === "" || entry.link || entry.inBundle || entry.integrity) continue;
	// A workspace or linked directory: its files are the repository's own, read where they are.
	if (!path.startsWith("node_modules/") && !path.includes("/node_modules/")) continue;
	fail(`${path} in ${lockfile} has no integrity${entry.resolved ? ` (${entry.resolved})` : ""}`);
}
