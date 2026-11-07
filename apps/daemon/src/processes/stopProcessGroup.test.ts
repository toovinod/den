import { isGoneWithin, killGroupOnExit, spawnDetachedShell, WITH_GRANDCHILD } from "../testing/processTesting.ts";
import { processExists, stopProcessGroup } from "./stopProcessGroup.ts";
import { Duration, Effect, type Scope } from "effect";
import { describe, expect, test } from "bun:test";

const run = <A, E>(program: Effect.Effect<A, E, Scope.Scope>) => program.pipe(Effect.scoped, Effect.runPromise);

describe("stopProcessGroup", () => {
	test("stops the child and its grandchild", async () => {
		const gone = await run(
			Effect.gen(function* () {
				const { shell, grandchild } = yield* spawnDetachedShell(WITH_GRANDCHILD);
				yield* killGroupOnExit(shell.pid);
				yield* stopProcessGroup(shell.pid);
				return yield* isGoneWithin(grandchild);
			}),
		);
		expect(gone).toBe(true);
	});

	test("sends SIGKILL to a group that ignores SIGTERM once the grace is over", async () => {
		const result = await run(
			Effect.gen(function* () {
				const { shell, grandchild } = yield* spawnDetachedShell(`trap '' TERM; ${WITH_GRANDCHILD}`);
				yield* killGroupOnExit(shell.pid);
				yield* stopProcessGroup(shell.pid, { grace: Duration.millis(300) });
				yield* Effect.promise(() => shell.exited);
				return { signal: shell.signalCode, grandchildGone: yield* isGoneWithin(grandchild) };
			}),
		);
		expect(result).toEqual({ signal: "SIGKILL", grandchildGone: true });
	});

	test("does nothing when the group is already gone", async () => {
		const result = await run(
			Effect.gen(function* () {
				const { shell } = yield* spawnDetachedShell("echo 0");
				yield* Effect.promise(() => shell.exited);
				yield* stopProcessGroup(shell.pid);
				return yield* processExists(shell.pid);
			}),
		);
		expect(result).toBe(false);
	});
});
