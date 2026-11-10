import { capLineLength, LINE_MAX_LENGTH } from "./capLineLength.ts";
import { describe, expect, test } from "bun:test";
import { Effect, Stream } from "effect";

const linesOf = (...chunks: ReadonlyArray<string>) =>
	Stream.make(...chunks).pipe(capLineLength, Stream.splitLines, Stream.runCollect, Effect.runPromise);

describe("capLineLength", () => {
	test("leaves short lines and every kind of line break as they were", async () => {
		expect(await linesOf("one\ntw", "o\r", "\nthree\rfour")).toEqual(["one", "two", "three", "four"]);
	});

	test("cuts a line that grows past the cap across chunks, and starts the next line fresh", async () => {
		const half = "x".repeat(LINE_MAX_LENGTH / 2 + 1);
		expect(await linesOf(half, half, half, "\nnext")).toEqual(["x".repeat(LINE_MAX_LENGTH), "next"]);
	});
});
