import { describe, expect, test } from "bun:test";
import { Effect, Redacted, Stdio, Stream } from "effect";
import { DaemonConfig } from "./DaemonConfig.ts";

const encoder = new TextEncoder();

const configFromStdin = (...chunks: ReadonlyArray<string>) =>
	Effect.gen(function* () {
		return yield* DaemonConfig;
	}).pipe(
		Effect.provide(DaemonConfig.layer),
		Effect.provide(
			Stdio.layerTest({
				stdin: Stream.fromIterable(
					chunks.map((chunk) => encoder.encode(chunk)),
				),
			}),
		),
		Effect.result,
		Effect.runPromise,
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
});
