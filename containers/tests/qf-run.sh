#!/bin/bash
# One Tests run of the "Container" runner: clones the PR head, installs dependencies, runs the
# repository's own vitest and, when configured, its typecheck. It reports only through files in
# $OUT, which the TestBox Durable Object reads (src/checks/tests/container.ts):
#   steps            one line per finished step: "<name> <exit code> <milliseconds>"
#   current          the step running now
#   <step>.log       the step's output
#   report.json      vitest's JSON report
#   cpu              CPU the container used, in microseconds (cgroup v2 usage_usec)
#   done             written last
# Then it waits for the Durable Object to read them and destroy the container.
#
# Environment: REPO ("owner/repo"), SHA, TOKEN (read-only, this repository only), and optionally
# INSTALL (a shell command), VITEST_ARGS (one argument per line) and TYPECHECK (a shell command).
set -u

OUT=/work/out
mkdir -p "$OUT" /work/repo
: >"$OUT/steps"

# step <name> <seconds>: runs the function <name> with a hard time limit, logging to $OUT/<name>.log.
step() {
	local name=$1 limit=$2 start code
	echo "$name" >"$OUT/current"
	start=$(date +%s%3N)
	timeout --kill-after=10 "$limit" bash -c "$name" >>"$OUT/$name.log" 2>&1
	code=$?
	echo "$name $code $(($(date +%s%3N) - start))" >>"$OUT/steps"
	return "$code"
}

clone() {
	local auth
	auth=$(printf 'x-access-token:%s' "$TOKEN" | base64 -w0)
	git init -q . &&
		git -c "http.extraHeader=Authorization: Basic $auth" fetch -q --depth=1 "https://github.com/$REPO" "$SHA" &&
		git checkout -q FETCH_HEAD
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

typecheck() {
	bash -c "$TYPECHECK"
}

export OUT
export -f clone install tests typecheck

run() {
	cd /work/repo || return
	step clone 300 || return
	unset TOKEN
	export CI=true
	step install 600 || return
	step tests 1500
	if [ -n "${TYPECHECK:-}" ]; then step typecheck 600; fi
}

run
grep -s usage_usec /sys/fs/cgroup/cpu.stat | cut -d' ' -f2 >"$OUT/cpu"
echo done >"$OUT/done"
# The Durable Object destroys the container once it has read the results.
exec sleep 900
