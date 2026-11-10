import { TerminalNotFoundError, type TerminalOutput } from "@repo/contracts/Terminal";
import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test";
import { followTerminal } from "./followTerminal.ts";
import type { Follow } from "./daemonRuntime.ts";

// A fake daemon: each attach is recorded, and the test drives its stream.
const fakeDaemon = () => {
	const attaches: Array<Follow<TerminalOutput>> = [];
	let stops = 0;
	const attach = (follow: Follow<TerminalOutput>) => {
		attaches.push(follow);
		return () => {
			stops++;
		};
	};
	return { attach, attaches, stops: () => stops };
};

const fakeScreen = () => {
	let text = "";
	return {
		screen: {
			reset: () => {
				text = "";
			},
			write: (data: string) => {
				text += data;
			},
		},
		text: () => text,
	};
};

beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

describe("followTerminal", () => {
	test("reattaches after the connection drops and shows the scrollback once", () => {
		const daemon = fakeDaemon();
		const view = fakeScreen();
		followTerminal(daemon.attach, view.screen);
		daemon.attaches[0]?.onItem({ type: "data", data: "$ ls\r\n" });
		daemon.attaches[0]?.onEnd?.(new Error("socket closed"));
		expect(view.text()).toContain("Disconnected. Reconnecting");

		jest.advanceTimersByTime(1000);
		expect(daemon.attaches).toHaveLength(2);
		// The daemon replays everything it kept as the first data event of the new attach.
		daemon.attaches[1]?.onItem({ type: "data", data: "$ ls\r\nREADME.md\r\n" });
		expect(view.text()).toBe("$ ls\r\nREADME.md\r\n");
	});

	test("says the shell exited and does not reattach", () => {
		const daemon = fakeDaemon();
		const view = fakeScreen();
		followTerminal(daemon.attach, view.screen);
		daemon.attaches[0]?.onItem({ type: "exit", exitCode: 0 });
		daemon.attaches[0]?.onEnd?.(null);
		jest.advanceTimersByTime(5000);
		expect(view.text()).toContain("The shell exited with code 0");
		expect(view.text()).not.toContain("Reconnecting");
		expect(daemon.attaches).toHaveLength(1);
	});

	test("stops trying when the daemon no longer has the terminal", () => {
		const daemon = fakeDaemon();
		const view = fakeScreen();
		followTerminal(daemon.attach, view.screen);
		daemon.attaches[0]?.onEnd?.(new TerminalNotFoundError({ terminalId: "t1" }));
		jest.advanceTimersByTime(5000);
		expect(view.text()).toContain("This terminal has closed");
		expect(daemon.attaches).toHaveLength(1);
	});

	test("a stopped terminal does not reattach", () => {
		const daemon = fakeDaemon();
		const view = fakeScreen();
		const stop = followTerminal(daemon.attach, view.screen);
		daemon.attaches[0]?.onEnd?.(new Error("socket closed"));
		stop();
		jest.advanceTimersByTime(5000);
		expect(daemon.attaches).toHaveLength(1);
		expect(daemon.stops()).toBe(1);
	});
});
