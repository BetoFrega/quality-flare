/**
 * Served as /admin/live.js. Pages with `data-live` (the run list, or a running run) open a
 * WebSocket to /admin/live and update in place as tests finish; when a run starts or ends,
 * the page reloads to show what D1 recorded. Without the socket, it falls back to reloading.
 */
export const LIVE_SCRIPT = `(() => {
	const root = document.querySelector("[data-live]");
	if (!root) return;
	const watching = root.dataset.live;
	const counts = new Map();
	const icon = (s) => (s === "pass" ? "✓" : s === "fail" ? "✗" : "–");
	const css = (s) => (s === "pass" ? "success" : s === "fail" ? "failure" : "skip");

	function progress(runId) {
		let c = counts.get(runId);
		if (!c) counts.set(runId, (c = { pass: 0, fail: 0, other: 0, total: undefined }));
		return c;
	}

	function render(runId) {
		const c = progress(runId);
		const done = c.pass + c.fail + c.other;
		if (!done && c.status) return document.querySelectorAll('[data-progress="' + runId + '"]').forEach((el) => (el.textContent = c.status));
		const text =
			(c.total ? done + " de " + c.total : done + " testes") +
			(c.fail ? " · " + c.fail + (c.fail === 1 ? " falhou" : " falharam") : "") +
			(c.counted && c.status ? " · " + c.status : "");
		document.querySelectorAll('[data-progress="' + runId + '"]').forEach((el) => (el.textContent = text));
	}

	function addTest(event) {
		const c = progress(event.runId);
		if (event.state === "pass") c.pass++;
		else if (event.state === "fail") c.fail++;
		else c.other++;
		const list = document.querySelector('[data-tests="' + event.runId + '"]');
		if (list) {
			const li = document.createElement("li");
			const state = document.createElement("span");
			state.className = "state " + css(event.state);
			state.textContent = icon(event.state) + " ";
			li.append(state, event.file + " › " + event.name);
			for (const error of event.errors || []) {
				const pre = document.createElement("pre");
				pre.textContent = error;
				li.append(pre);
			}
			list.append(li);
		}
	}

	// A container run lists only its failures and sends the totals.
	function setCounts(event) {
		Object.assign(progress(event.runId), { pass: event.pass, fail: event.fail, other: event.other, total: event.total, counted: true });
	}

	function handle(event) {
		if (event.type === "started" || event.type === "finished") return location.reload();
		if (event.type === "snapshot") {
			progress(event.runId).total = event.total;
			progress(event.runId).status = event.status;
			for (const test of event.tests) addTest(test);
			if (event.counts) setCounts(event.counts);
		}
		if (event.type === "collected") progress(event.runId).total = (progress(event.runId).total || 0) + event.total;
		if (event.type === "test") addTest(event);
		if (event.type === "status") progress(event.runId).status = event.text;
		if (event.type === "counts") setCounts(event);
		render(event.runId);
	}

	let failures = 0;
	function connect() {
		const ws = new WebSocket((location.protocol === "https:" ? "wss://" : "ws://") + location.host + "/admin/live?run=" + watching);
		ws.onopen = () => (failures = 0);
		ws.onmessage = (message) => handle(JSON.parse(message.data));
		ws.onclose = () => (++failures > 3 ? setTimeout(() => location.reload(), 5000) : setTimeout(connect, 1000 * failures));
	}
	connect();
})();
`;
