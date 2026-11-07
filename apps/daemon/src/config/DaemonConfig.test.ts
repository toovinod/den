import { Duration, Effect, Option, Redacted, Stdio, Stream } from "effect";
import { describe, expect, test } from "bun:test";
import { DaemonConfig } from "./DaemonConfig.ts";

const encoder = new TextEncoder();

const stdinOf = (...chunks: ReadonlyArray<string>) => Stream.fromIterable(chunks.map((chunk) => encoder.encode(chunk)));

const withStdin = <A, E>(stdin: Stream.Stream<Uint8Array>, program: Effect.Effect<A, E, DaemonConfig>) =>
	program.pipe(
		Effect.provide(DaemonConfig.layer),
		Effect.provide(Stdio.layerTest({ stdin })),
		Effect.result,
		Effect.runPromise,
	);

const configFromStdin = (...chunks: ReadonlyArray<string>) =>
	withStdin(
		stdinOf(...chunks),
		Effect.gen(function* () {
			return yield* DaemonConfig;
		}),
	);

const parentExitedWithin = (stdin: Stream.Stream<Uint8Array>, timeout: Duration.Input) =>
	withStdin(
		stdin,
		Effect.gen(function* () {
			const { parentExited } = yield* DaemonConfig;
			return Option.isSome(yield* Effect.timeoutOption(parentExited, timeout));
		}),
	);

describe("DaemonConfig", () => {
	test("reads the token from the first line of stdin", async () => {
		const result = await configFromStdin("abc", "123\n", "ignored\n");
		expect(result._tag).toBe("Success");
		if (result._tag === "Success") {
			expect(Redacted.value(result.success.token)).toBe("abc123");
		}
	});

	test("fails when stdin closes without a token", async () => {
		const result = await configFromStdin();
		expect(result._tag).toBe("Failure");
		if (result._tag === "Failure") {
			expect(result.failure._tag).toBe("DaemonTokenMissingError");
		}
	});

	test("reports the parent gone once stdin closes after the token", async () => {
		const result = await parentExitedWithin(stdinOf("abc\n"), Duration.seconds(1));
		expect(result).toMatchObject({ _tag: "Success", success: true });
	});

	test("keeps waiting while stdin stays open", async () => {
		const result = await parentExitedWithin(Stream.concat(stdinOf("abc\n"), Stream.never), Duration.millis(50));
		expect(result).toMatchObject({ _tag: "Success", success: false });
	});
});
