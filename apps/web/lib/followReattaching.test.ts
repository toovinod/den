import { followReattaching } from "./followReattaching.ts";
import { describe, expect, test } from "bun:test";
import type { Follow } from "./daemonRuntime.ts";

// A stream that replays "a" on every attach, drops the first connection, and ends on the second.
const droppingOnce = () => {
	let attaches = 0;
	const follow = (handlers: Follow<string>) => {
		attaches++;
		handlers.onItem("a");
		if (attaches === 1) handlers.onEnd?.(new Error("socket closed"));
		else {
			handlers.onItem("b");
			handlers.onEnd?.(null);
		}
		return () => undefined;
	};
	return { follow, attaches: () => attaches };
};

describe("followReattaching", () => {
	test("attaches to the same stream again after the connection drops", async () => {
		const stream = droppingOnce();
		const seen: Array<string> = [];
		const ended = await new Promise<unknown>((resolve) => {
			followReattaching(stream.follow, {
				onItem: (item) => seen.push(item),
				onReattach: () => seen.push("reattached"),
				onEnd: resolve,
			});
		});
		expect(ended).toBeNull();
		expect(seen).toEqual(["a", "reattached", "a", "b"]);
		expect(stream.attaches()).toBe(2);
	});

	test("stopping while waiting to reattach stops for good", async () => {
		const stream = droppingOnce();
		const stop = followReattaching(stream.follow, { onItem: () => undefined, onReattach: () => undefined });
		stop();
		await Bun.sleep(1500);
		expect(stream.attaches()).toBe(1);
	});
});
