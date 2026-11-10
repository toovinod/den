import { describe, expect, mock, test } from "bun:test";

// The daemon answers each sendMessage with the next of these outcomes.
const outcomes: Array<"ok" | "busy"> = [];
const sent: Array<string> = [];

mock.module("./daemonRuntime.ts", () => ({
	callDaemon: (call: (daemon: unknown) => unknown) => {
		call({
			sendMessage: ({ text }: { readonly text: string }) => {
				sent.push(text);
			},
		});
		return outcomes.shift() === "busy"
			? Promise.reject({ _tag: "SessionBusyError", message: "The agent is busy. Try again." })
			: Promise.resolve();
	},
	followDaemon: () => () => {},
	errorMessage: (error: { readonly message: string }) => error.message,
	errorTag: () => null,
}));

const { discardFailedSend, failedSendsOf, getState, retryFailedSend, sendMessage } = await import("./store.ts");

describe("failed sends", () => {
	test("keep a refused message per chat until it is retried or discarded", async () => {
		outcomes.push("busy", "busy", "ok");
		await sendMessage("a", "first", [], false);
		await sendMessage("a", "second", [], false);
		expect(failedSendsOf(getState(), "a").map(({ text, error }) => [text, error])).toEqual([
			["first", "The agent is busy. Try again."],
			["second", "The agent is busy. Try again."],
		]);
		expect(failedSendsOf(getState(), "b")).toEqual([]);

		const [first, second] = failedSendsOf(getState(), "a");
		await retryFailedSend("a", first?.id ?? -1, false);
		expect(failedSendsOf(getState(), "a").map(({ text }) => text)).toEqual(["second"]);

		discardFailedSend("a", second?.id ?? -1);
		expect(getState().failedSends).toEqual({});
		expect(sent).toEqual(["first", "second", "first"]);
	});

	test("a retry that fails again keeps the message", async () => {
		outcomes.push("busy", "busy");
		await sendMessage("c", "hello", [], true);
		const [failed] = failedSendsOf(getState(), "c");
		await retryFailedSend("c", failed?.id ?? -1, true);
		expect(failedSendsOf(getState(), "c").map(({ text }) => text)).toEqual(["hello"]);
	});
});
