#!/bin/bash
# One run of the "Container tests" check: clones the PR head merged into its base, installs dependencies, then runs the
# repository's own vitest alongside its config's commands (one after another), each its own check run. It reports
# only through files in
# $OUT, which the TestBox Durable Object reads (src/checks/tests/container.ts):
#   steps            one line per finished step: "<name> <exit code> <milliseconds>"
#   current          the step running now (clone, install, or tests while tests and commands run)
#   <step>.log       the step's output
#   progress.json    tests so far, while they run (qf-progress.mjs)
#   report.json      vitest's JSON report
#   cpu              CPU the container used, in microseconds (cgroup v2 usage_usec)
#   snapshot         with SNAPSHOT=1, while the run waits for TestBox to snapshot the container: the install ran on
#                    the base's lockfile. TestBox removes it once the snapshot is taken.
#   done             written last
# Then it waits for the Durable Object to read them and destroy the container.
#
# Environment: REPO ("owner/repo"), SHA, BASE (the PR's base branch), TOKEN (read-only, this
# repository only), and optionally INSTALL (a shell command), VITEST_ARGS (one argument per line),
# COMMANDS (how many) with COMMAND_1, COMMAND_2… (shell commands, run as steps command1…), CHANGED=1
# (only the tests that depend on what the PR changed, plus ALWAYS_RUN) or FULL=1 (SHA on its own, everything;
# Turborepo's --affected sees every package changed), CACHE_PATHS (one path per line) with CACHE_API and
# CACHE_TOKEN, and SNAPSHOT=1.
#
# With SNAPSHOT=1 the container may start from a snapshot of an earlier run's (TestBox decides): /work/repo
# then already has a clone and its node_modules. The clone is brought to SHA and cleaned of everything else,
# and the install is skipped when the lockfile is the one installed there.
set -u

OUT=/work/out
# A container from a snapshot still has the earlier run's output.
rm -rf "$OUT"
mkdir -p "$OUT" /work/repo
: >"$OUT/steps"

# step <name> <seconds> [<command>]: runs <command> (by default the function <name>) with a hard time
# limit, logging to $OUT/<name>.log.
step() {
	local name=$1 limit=$2 command=${3:-$1} start code
	start=$(date +%s%3N)
	timeout --kill-after=10 "$limit" bash -c "$command" >>"$OUT/$name.log" 2>&1
	code=$?
	echo "$name $code $(($(date +%s%3N) - start))" >>"$OUT/steps"
	return "$code"
}

# The base branch comes with its history, as origin/$BASE, for commands that compare against it
# (turbo --affected, diffs). Blobs are fetched as needed, so the token stays in the repository's git
# config for the whole run; it reads only this repository, which the code under test already has.
clone() {
	if [ -d .git ]; then git remote set-url origin "https://github.com/$REPO"
	else git init -q . && git remote add origin "https://github.com/$REPO"
	fi &&
		git config http.extraHeader "Authorization: Basic $(printf 'x-access-token:%s' "$TOKEN" | base64 -w0)" &&
		git fetch -q --filter=blob:none origin "$SHA" "+refs/heads/$BASE:refs/remotes/origin/$BASE" &&
		git checkout -q -f "$SHA" &&
		clean_snapshot &&
		if [ -n "${FULL:-}" ]; then compare_with_nothing; else merge_base; fi
}

# What an earlier run left in a clone from a snapshot goes, but for the installed dependencies (every
# node_modules) and the config's cache paths: no build output of another commit reaches the tests.
clean_snapshot() {
	local keep=(-e node_modules) path
	[ -f /work/installed ] || return 0
	[ -n "${CACHE_PATHS:-}" ] && while IFS= read -r path; do keep+=(-e "/$path"); done <<<"$CACHE_PATHS"
	git clean -q -ffdx "${keep[@]}"
}

# A full run tests a branch's commit on its own, so origin/$BASE stays the branch itself: commands
# that read the base (a rule that compares a file with the base's copy) find the files as they are.
# Turborepo's --affected would then find nothing changed, so TURBO_SCM_BASE (set in run) points it at
# refs/quality-flare/nothing, a commit with no files and no shared history: against it, everything
# changed, as on a repository's first commit. A command that sets TURBO_SCM_BASE itself should keep
# the one it gets.
compare_with_nothing() {
	git update-ref refs/quality-flare/nothing \
		"$(git -c user.name=quality-flare -c user.email=quality-flare@users.noreply.github.com commit-tree "$(git hash-object -w -t tree /dev/null)" -m "quality-flare: nothing")"
}

# Like GitHub Actions on pull_request, the checks run on the PR merged into its base: a PR behind its
# base would otherwise fail checks that compare against origin/$BASE (a rule the base added since).
merge_base() {
	git -c user.name=quality-flare -c user.email=quality-flare@users.noreply.github.com \
		merge -q --no-edit --no-ff "origin/$BASE" && return
	echo "A PR tem conflito com $BASE. Resolva o conflito para rodar os checks."
	return 1
}

# Skipped when the container came from a snapshot that installed the same lockfile (and command). /work/installed
# says which; it goes first, so a failed install never claims one.
install() {
	local key
	key=$({ cat package-lock.json npm-shrinkwrap.json pnpm-lock.yaml yarn.lock bun.lock bun.lockb 2>/dev/null; echo "${INSTALL:-}"; } | sha256sum | cut -d' ' -f1)
	if [ -d node_modules ] && [ "$(cat /work/installed 2>/dev/null)" = "$key" ]; then
		echo "Dependências já instaladas: o container veio de um snapshot com este lockfile."
		return
	fi
	rm -f /work/installed
	install_dependencies || return
	echo "$key" >/work/installed
	# A PR that changes the lockfile would leave a snapshot most PRs can't use.
	if [ -n "${SNAPSHOT:-}" ] && git diff --quiet "origin/$BASE" HEAD -- package-lock.json npm-shrinkwrap.json pnpm-lock.yaml yarn.lock bun.lock bun.lockb; then
		wait_for_snapshot
	fi
}

# The snapshot is taken now, before any of the repository's code runs, so no run can leave anything in the
# node_modules of the next. Without the token in the git config, though the clone still needs it for the
# blobs it fetches as needed.
wait_for_snapshot() {
	local header i=0
	header=$(git config http.extraHeader)
	git config --unset-all http.extraHeader
	touch "$OUT/snapshot"
	while [ -e "$OUT/snapshot" ] && ((i++ < 300)); do sleep 1; done
	[ -e "$OUT/snapshot" ] && echo "O snapshot não foi tirado a tempo; a run segue sem ele."
	rm -f "$OUT/snapshot"
	git config http.extraHeader "$header"
}

install_dependencies() {
	if [ -n "${INSTALL:-}" ]; then bash -c "$INSTALL"
	elif [ -f pnpm-lock.yaml ]; then pnpm install --frozen-lockfile --ignore-scripts
	elif [ -f yarn.lock ]; then yarn install --frozen-lockfile --ignore-scripts
	elif [ -f package-lock.json ]; then npm ci --ignore-scripts --no-audit --no-fund
	else npm install --ignore-scripts --no-audit --no-fund
	fi
}

tests() {
	local args=()
	[ -n "${VITEST_ARGS:-}" ] && mapfile -t args <<<"$VITEST_ARGS"
	[ -n "${CHANGED:-}" ] && affected
	npx --no-install vitest run "${args[@]}" --reporter=dot --reporter=/usr/local/lib/qf-progress.mjs --reporter=json --outputFile.json="$OUT/report.json"
}

# Narrows the tests (args) to the files whose imports reach what the PR changed (vitest lists all of them
# when the vitest config changed), plus ALWAYS_RUN (one vitest filter per line): tests that read files or
# run scripts, which vitest's module graph can't connect to a change. If vitest can't list them, every
# test runs.
affected() {
	local listed file files=() always=() since=origin/$BASE index=()
	if git diff --name-only "origin/$BASE" HEAD | grep -qE '(^|/)(package\.json|package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?)$'; then
		related_index || return 0
		since=HEAD index=(GIT_INDEX_FILE=/work/related-index)
	fi
	listed=$(env "${index[@]}" npx --no-install vitest list "${args[@]}" --changed "$since" --filesOnly) || return 0
	# With several vitest projects each line starts with its project's name: "[unit] src/a.test.ts".
	while IFS= read -r file; do file=${file#\[*\] }; [ -f "$file" ] && files+=("$file"); done <<<"$listed"
	[ -n "${ALWAYS_RUN:-}" ] && mapfile -t always <<<"$ALWAYS_RUN"
	echo "Só os testes afetados pela PR: ${#files[@]} arquivo(s), mais ${#always[@]} filtro(s) que sempre rodam."
	# No file at all: a filter nothing matches, which --passWithNoTests turns into a pass.
	((${#files[@]} + ${#always[@]})) || files=(--changed "$since")
	args+=("${files[@]}" "${always[@]}" --passWithNoTests)
}

# A package.json or lockfile changed: vitest would run every test for a package.json and none for a
# lockfile. qf-related turns them into the files that use the packages that changed (the vitest config
# in args tells it which packages the run itself uses), which vitest
# --changed HEAD then sees as staged: removed from a copy of the index, /work/related-index.
# Fails (every test runs) when the change reaches everything.
related_index() {
	local related config i
	for ((i = 0; i < ${#args[@]}; i++)); do
		case ${args[i]} in
		--config | -c) config=${args[i + 1]-} ;;
		--config=*) config=${args[i]#--config=} ;;
		esac
	done
	related=$(node /usr/local/lib/qf-related.mjs "origin/$BASE" ${config:+"$config"}) || return 1
	if [ "$related" = all ]; then
		echo "A PR muda pacotes que a configuração do vitest usa: todos os testes rodam."
		return 1
	fi
	echo "A PR muda package.json ou lockfile: $(grep -c . <<<"$related") arquivo(s) contam como mudados."
	cp "$(git rev-parse --absolute-git-dir)/index" /work/related-index &&
		{ [ -z "$related" ] || GIT_INDEX_FILE=/work/related-index git --literal-pathspecs rm -q --cached --ignore-unmatch --pathspec-from-file=- <<<"$related"; }
}

# The config's `cache`: files the tools keep between runs (ESLint's cache, tsc's .tsbuildinfo…), kept in
# quality-flare's Turborepo cache (src/turbo-cache.ts) under one key per lockfile, so new dependencies start
# them over. Restored after the install, which may empty node_modules; saved at the end. Both are best effort:
# without them the tools only take longer.
cache_url() {
	echo "$CACHE_API/v8/artifacts/qf-files-$(cat package-lock.json npm-shrinkwrap.json pnpm-lock.yaml yarn.lock bun.lock 2>/dev/null | sha256sum | cut -c1-32)"
}

restore_cache() {
	curl -fsS --max-time 60 -H "Authorization: Bearer $CACHE_TOKEN" -o /work/cache.tgz "$(cache_url)" &&
		tar -xzf /work/cache.tgz && echo "Cache restaurado: $(du -h /work/cache.tgz | cut -f1)."
	rm -f /work/cache.tgz
}

# Not after a step that hit its time limit: a tool stopped mid-write can leave its cache broken.
save_cache() {
	local paths=() path present=()
	if grep -q ' 124 ' "$OUT/steps"; then echo "Cache não salvo: um passo passou do limite."; return; fi
	mapfile -t paths <<<"$CACHE_PATHS"
	for path in "${paths[@]}"; do [ -e "$path" ] && present+=("$path"); done
	((${#present[@]})) || return 0
	tar -czf /work/cache.tgz "${present[@]}" &&
		if (($(stat -c %s /work/cache.tgz) > 90 * 1024 * 1024)); then echo "Cache não salvo: passa de 90 MB."
		else curl -fsS --max-time 120 -X PUT -H "Authorization: Bearer $CACHE_TOKEN" -H "Content-Type: application/octet-stream" \
			--data-binary @/work/cache.tgz "$(cache_url)" >/dev/null && echo "Cache salvo: $(du -h /work/cache.tgz | cut -f1)."
		fi
	rm -f /work/cache.tgz
}

# run_command <n>: the shell command COMMAND_<n>.
run_command() {
	local var=COMMAND_$1
	bash -c "${!var}"
}

# The commands, one after another.
commands() {
	local i
	for ((i = 1; i <= ${COMMANDS:-0}; i++)); do step "command$i" 900 "run_command $i"; done
}

export OUT
export -f step clone clean_snapshot merge_base compare_with_nothing install install_dependencies wait_for_snapshot affected related_index tests run_command commands

run() {
	cd /work/repo || return
	echo clone >"$OUT/current"
	step clone 300 || return
	unset TOKEN
	# As on GitHub Actions, for scripts written for it.
	export CI=true GITHUB_BASE_REF=$BASE GITHUB_SHA=$SHA
	[ -n "${FULL:-}" ] && export TURBO_SCM_BASE=refs/quality-flare/nothing TURBO_SCM_HEAD=HEAD
	echo install >"$OUT/current"
	step install 600 || return
	[ -n "${CACHE_PATHS:-}" ] && restore_cache >>"$OUT/cache.log" 2>&1
	# The commands run one after another alongside the tests: alone, the tests leave vCPUs idle and
	# lint or typecheck use about one. At the lowest priority, so the tests keep the CPU their timeouts
	# expect; not all at once, so neither do the commands starve each other's timed tests.
	echo tests >"$OUT/current"
	step tests 900 &
	nice -n 19 bash -c commands &
	wait
	[ -n "${CACHE_PATHS:-}" ] && save_cache >>"$OUT/cache.log" 2>&1
	return 0
}


run
grep -s usage_usec /sys/fs/cgroup/cpu.stat | cut -d' ' -f2 >"$OUT/cpu"
echo done >"$OUT/done"
# The Durable Object destroys the container once it has read the results.
exec sleep 900
