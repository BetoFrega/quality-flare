#!/bin/bash
# One run of the "Container tests" check: clones the PR head merged into its base, installs dependencies, then runs the
# repository's own vitest alongside its config's commands (one after another), each its own check run. It reports
# only through files in
# $OUT, which the TestBox Durable Object reads (src/checks/tests/container.ts):
#   steps            one line per finished step: "<name> <exit code> <milliseconds>"
#   current          the step running now (clone, install, or tests while tests and commands run)
#   <step>.log       the step's output
#   report.json      vitest's JSON report
#   cpu              CPU the container used, in microseconds (cgroup v2 usage_usec)
#   done             written last
# Then it waits for the Durable Object to read them and destroy the container.
#
# Environment: REPO ("owner/repo"), SHA, BASE (the PR's base branch), TOKEN (read-only, this
# repository only), and optionally INSTALL (a shell command), VITEST_ARGS (one argument per line),
# and COMMANDS (how many) with COMMAND_1, COMMAND_2… (shell commands, run as steps command1…).
set -u

OUT=/work/out
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
	git init -q . &&
		git remote add origin "https://github.com/$REPO" &&
		git config http.extraHeader "Authorization: Basic $(printf 'x-access-token:%s' "$TOKEN" | base64 -w0)" &&
		git fetch -q --filter=blob:none origin "$SHA" "+refs/heads/$BASE:refs/remotes/origin/$BASE" &&
		git checkout -q "$SHA" &&
		merge_base
}

# Like GitHub Actions on pull_request, the checks run on the PR merged into its base: a PR behind its
# base would otherwise fail checks that compare against origin/$BASE (a rule the base added since).
merge_base() {
	git -c user.name=quality-flare -c user.email=quality-flare@users.noreply.github.com \
		merge -q --no-edit --no-ff "origin/$BASE" && return
	echo "A PR tem conflito com $BASE. Resolva o conflito para rodar os checks."
	return 1
}

install() {
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
	npx --no-install vitest run "${args[@]}" --reporter=dot --reporter=json --outputFile.json="$OUT/report.json"
}

# run_command <n>: the shell command COMMAND_<n>.
run_command() {
	local var=COMMAND_$1
	bash -c "${!var}"
}

# The commands, one after another.
commands() {
	local i
	for ((i = 1; i <= ${COMMANDS:-0}; i++)); do step "command$i" 1200 "run_command $i"; done
}

export OUT
export -f step clone merge_base install tests run_command commands

run() {
	cd /work/repo || return
	echo clone >"$OUT/current"
	step clone 300 || return
	unset TOKEN
	# As on GitHub Actions, for scripts written for it.
	export CI=true GITHUB_BASE_REF=$BASE GITHUB_SHA=$SHA
	echo install >"$OUT/current"
	step install 600 || return
	# The commands run one after another alongside the tests: alone, the tests leave vCPUs idle and
	# lint or typecheck use about one. At a lower priority, so the tests keep the CPU their timeouts
	# expect; not all at once, so neither do the commands starve each other's timed tests.
	echo tests >"$OUT/current"
	step tests 1500 &
	nice -n 10 bash -c commands &
	wait
}


run
grep -s usage_usec /sys/fs/cgroup/cpu.stat | cut -d' ' -f2 >"$OUT/cpu"
echo done >"$OUT/done"
# The Durable Object destroys the container once it has read the results.
exec sleep 900
