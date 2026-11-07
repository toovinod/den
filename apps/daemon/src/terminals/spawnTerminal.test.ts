import { isGoneWithin, WITH_GRANDCHILD } from "../testing/processTesting.ts";
import { testProcessRegistry } from "../testing/testProcessRegistry.ts";
import { Deferred, Duration, Effect } from "effect";
import { spawnTerminal } from "./spawnTerminal.ts";
import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";

describe("spawnTerminal", () => {
	test("closing the terminal stops the shell's children too", async () => {
		const gone = await Effect.gen(function* () {
			const firstLine = yield* Deferred.make<string>();
			const grandchild = yield* Effect.scoped(
				Effect.gen(function* () {
					const decoder = new TextDecoder();
					yield* spawnTerminal({
						command: ["/bin/sh", "-c", WITH_GRANDCHILD],
						cwd: tmpdir(),
						cols: 80,
						rows: 24,
						onData: (data) => Deferred.doneUnsafe(firstLine, Effect.succeed(decoder.decode(data))),
					});
					const output = yield* Deferred.await(firstLine).pipe(Effect.timeout(Duration.seconds(3)));
					return Number(output.trim().split(/\s+/)[0]);
				}),
			);
			return yield* isGoneWithin(grandchild);
		}).pipe(Effect.provide(testProcessRegistry), Effect.runPromise);
		expect(gone).toBe(true);
	});
});
