/** vitest's fake timers (its FakeTimers class, on @sinonjs/fake-timers), without the child process checks. */
import type { Clock as InstalledClock, Config as FakeTimerInstallOpts, withGlobal } from "@sinonjs/fake-timers";

const realNow = Date.now;
// Loaded by loadTimers(), in a request: the library sets a timeout as it loads, which Workers
// forbid at global scope.
let created: ReturnType<typeof withGlobal> | undefined;
const fakeTimers = () => created!;

export async function loadTimers(): Promise<void> {
	created ??= (await import("@sinonjs/fake-timers")).withGlobal(globalThis);
}
// Not mocked by default, as in vitest: the runtime itself relies on them.
const defaultToFake = () =>
	Object.keys(fakeTimers().timers).filter((t) => t !== "nextTick" && t !== "queueMicrotask") as FakeTimerInstallOpts["toFake"];

let clock: InstalledClock | undefined;
let fakingTime = false;
let fakingDate: Date | null = null;

function check(): InstalledClock {
	if (!fakingTime || !clock) {
		throw new Error("A function to advance timers was called but the timers APIs are not mocked. Call `vi.useFakeTimers()` in the test file first.");
	}
	return clock;
}

export const timers = {
	useFakeTimers(config: FakeTimerInstallOpts = {}) {
		const now = fakingDate ?? Date.now();
		if (clock) clock.uninstall();
		fakingDate = null;
		clock = fakeTimers().install({ now, ...config, toFake: config.toFake ?? defaultToFake(), ignoreMissingTimers: true });
		fakingTime = true;
	},
	useRealTimers() {
		clock?.uninstall();
		clock = undefined;
		fakingDate = null;
		fakingTime = false;
	},
	isFakeTimers: () => fakingTime,
	clearAllTimers() {
		if (fakingTime) clock?.reset();
	},
	runAllTimers: () => void check().runAll(),
	runAllTimersAsync: async () => void (await check().runAllAsync()),
	runOnlyPendingTimers: () => void check().runToLast(),
	runOnlyPendingTimersAsync: async () => void (await check().runToLastAsync()),
	advanceTimersByTime: (ms: number) => void check().tick(ms),
	advanceTimersByTimeAsync: async (ms: number) => void (await check().tickAsync(ms)),
	advanceTimersToNextTimer(steps = 1) {
		const c = check();
		for (let i = steps; i > 0; i--) {
			c.next();
			c.tick(0);
			if (c.countTimers() === 0) break;
		}
	},
	async advanceTimersToNextTimerAsync(steps = 1) {
		const c = check();
		for (let i = steps; i > 0; i--) {
			await c.nextAsync();
			c.tick(0);
			if (c.countTimers() === 0) break;
		}
	},
	advanceTimersToNextFrame: () => void check().runToFrame(),
	runAllTicks: () => void check().runMicrotasks(),
	getTimerCount: () => (fakingTime ? check().countTimers() : 0),
	setSystemTime(now?: number | string | Date) {
		const date = now === undefined || now instanceof Date ? now : new Date(now);
		if (fakingTime) return void clock!.setSystemTime(date);
		const next = date ?? new Date(realNow());
		if (fakingDate) clock!.setSystemTime(next);
		else clock = fakeTimers().install({ now: next, toFake: ["Date"], ignoreMissingTimers: true });
		fakingDate = next;
	},
	getMockedSystemTime: () => (fakingTime ? new Date(clock!.now) : fakingDate),
	getRealSystemTime: () => realNow(),
};
