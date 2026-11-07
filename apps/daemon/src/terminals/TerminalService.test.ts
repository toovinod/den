import { ConfigProvider, Effect, FileSystem, Layer, Stream } from "effect";
import { SCROLLBACK_MAX_LINES, Scrollback } from "./Scrollback.ts";
import { TerminalService } from "./TerminalService.ts";
import { BunServices } from "@effect/platform-bun";
import { describe, expect, test } from "bun:test";
import { SecureRandom } from "effect/crypto";

const size = { cols: 80, rows: 24 };

const runTerminalTest = <A, E>(program: (tempDir: string) => Effect.Effect<A, E, TerminalService>) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const tempDir = yield* fs.realPath(yield* fs.makeTempDirectoryScoped());
		return yield* program(tempDir).pipe(Effect.provide(TerminalService.layer));
	}).pipe(
		Effect.scoped,
		Effect.provide(
			Layer.mergeAll(
				BunServices.layer,
				SecureRandom.layerWebCrypto,
				ConfigProvider.layer(ConfigProvider.fromEnv({ env: { SHELL: "/bin/sh" } })),
			),
		),
		Effect.runPromise,
	);

const outputText = (outputs: ReadonlyArray<{ readonly type: string; readonly data?: string }>) =>
	outputs.map((output) => output.data ?? "").join("");

describe("TerminalService", () => {
	test("runs a shell in the workspace folder and streams its output until it exits", async () => {
		const result = await runTerminalTest((tempDir) =>
			Effect.gen(function* () {
				const terminals = yield* TerminalService;
				const info = yield* terminals.open("workspace-1", tempDir, size);
				const listed = terminals.list("workspace-1");
				yield* terminals.write(info.id, "pwd; echo done-$((1 + 1)); exit 7\n");
				const outputs = yield* Stream.runCollect(terminals.attach(info.id));
				return { tempDir, listed, outputs, afterExit: terminals.list("workspace-1") };
			}),
		);
		expect(result.listed).toHaveLength(1);
		expect(outputText(result.outputs)).toContain(result.tempDir);
		expect(outputText(result.outputs)).toContain("done-2");
		expect(result.outputs.at(-1)).toEqual({ type: "exit", exitCode: 7 });
		expect(result.afterExit).toEqual([]);
	});

	test("a client that attaches later gets the scrollback first", async () => {
		const text = await runTerminalTest((tempDir) =>
			Effect.gen(function* () {
				const terminals = yield* TerminalService;
				const info = yield* terminals.open("workspace-1", tempDir, size);
				yield* terminals.write(info.id, "echo early-line\n");
				// Wait until the shell printed it, then attach a fresh client.
				yield* terminals.attach(info.id).pipe(
					Stream.takeUntil((output) => output.type === "data" && output.data.includes("early-line\r\n")),
					Stream.runDrain,
				);
				const first = yield* terminals.attach(info.id).pipe(Stream.take(1), Stream.runCollect);
				return outputText(first);
			}),
		);
		expect(text).toContain("early-line");
	});

	test("closing the workspace kills its terminals and only those", async () => {
		const result = await runTerminalTest((tempDir) =>
			Effect.gen(function* () {
				const terminals = yield* TerminalService;
				const first = yield* terminals.open("workspace-1", tempDir, size);
				yield* terminals.open("workspace-1", tempDir, size);
				const other = yield* terminals.open("workspace-2", tempDir, size);
				yield* terminals.resize(first.id, { cols: 120, rows: 40 });
				yield* terminals.closeWorkspace("workspace-1");
				return {
					closed: terminals.list("workspace-1"),
					kept: terminals.list("workspace-2").map((info) => info.id),
					other: other.id,
					writeError: yield* Effect.flip(terminals.write(first.id, "x")),
				};
			}),
		);
		expect(result.closed).toEqual([]);
		expect(result.kept).toEqual([result.other]);
		expect(result.writeError._tag).toBe("TerminalNotFoundError");
	});
});

describe("Scrollback", () => {
	test("keeps only the newest lines", () => {
		const scrollback = new Scrollback();
		for (let line = 0; line < SCROLLBACK_MAX_LINES + 100; line++) {
			scrollback.append(`line ${line}\n`);
		}
		const kept = scrollback.toString().split("\n");
		expect(kept[0]).toBe("line 100");
		expect(kept).toHaveLength(SCROLLBACK_MAX_LINES + 1);
	});

	test("trims a single huge chunk to the newest lines", () => {
		const scrollback = new Scrollback();
		scrollback.append(Array.from({ length: SCROLLBACK_MAX_LINES * 2 }, (_, line) => `line ${line}`).join("\n"));
		const kept = scrollback.toString().split("\n");
		expect(kept).toHaveLength(SCROLLBACK_MAX_LINES);
		expect(kept.at(-1)).toBe(`line ${SCROLLBACK_MAX_LINES * 2 - 1}`);
	});
});
