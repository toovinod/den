import { TerminalInfo, TerminalNotFoundError, TerminalSpawnError } from "@repo/contracts/Terminal";
import { Config, Context, Deferred, Effect, FiberMap, Layer, PubSub, Stream } from "effect";
import type { TerminalOutput } from "@repo/contracts/Terminal";
import type { SecureRandom } from "effect/crypto";
import { nowIso } from "../database/nowIso.ts";
import { newId } from "../database/newId.ts";
import { Scrollback } from "./Scrollback.ts";
import { basename } from "node:path";

interface Size {
	readonly cols: number;
	readonly rows: number;
}

// index orders live output against the scrollback snapshot a new client starts from.
type IndexedOutput = { readonly index: number; readonly output: TerminalOutput };

interface RunningTerminal {
	readonly info: TerminalInfo;
	readonly pty: Bun.Terminal;
	readonly scrollback: Scrollback;
	readonly output: PubSub.PubSub<IndexedOutput>;
	readonly appended: { count: number };
}

// A slow client loses old output rather than growing the daemon's memory.
const LIVE_BUFFER = 4096;

export class TerminalService extends Context.Service<TerminalService>()("swarm/daemon/terminals/TerminalService", {
	make: Effect.gen(function* () {
		const shell = yield* Config.String("SHELL").pipe(Config.withDefault("/bin/sh"));
		const services = yield* Effect.context<SecureRandom.SecureRandom>();
		const terminals = new Map<string, RunningTerminal>();
		// One fiber per terminal owns its PTY. Interrupting it, or stopping the daemon, kills the shell.
		const fibers = yield* FiberMap.make<string>();

		const publish = (terminal: RunningTerminal, output: TerminalOutput) => {
			terminal.appended.count++;
			PubSub.publishUnsafe(terminal.output, { index: terminal.appended.count, output });
		};

		const acquirePty = (info: TerminalInfo, cwd: string, size: Size) =>
			Effect.acquireRelease(
				Effect.gen(function* () {
					const output = yield* PubSub.sliding<IndexedOutput>(LIVE_BUFFER);
					const decoder = new TextDecoder();
					const scrollback = new Scrollback();
					const appended = { count: 0 };
					const spawned = yield* Effect.try({
						try: () => {
							const pty = new Bun.Terminal({
								...size,
								data: (_pty, bytes) => {
									const data = decoder.decode(bytes, { stream: true });
									scrollback.append(data);
									publish(terminal, { type: "data", data });
								},
							});
							const process = Bun.spawn([shell, "-l"], { cwd, terminal: pty });
							return { pty, process };
						},
						catch: (cause) => new TerminalSpawnError({ shell, cause }),
					});
					const terminal: RunningTerminal = { info, pty: spawned.pty, scrollback, output, appended };
					return { terminal, process: spawned.process };
				}),
				({ terminal, process }) =>
					Effect.sync(() => {
						process.kill("SIGHUP");
						terminal.pty.close();
					}).pipe(Effect.andThen(PubSub.shutdown(terminal.output))),
			);

		const open = Effect.fn("TerminalService.open")(function* (workspaceId: string, cwd: string, size: Size) {
			const info = new TerminalInfo({
				id: yield* newId,
				workspaceId,
				title: basename(shell),
				createdAt: yield* nowIso,
			});
			const ready = yield* Deferred.make<void, TerminalSpawnError>();
			const run = Effect.gen(function* () {
				const { terminal, process } = yield* acquirePty(info, cwd, size);
				terminals.set(info.id, terminal);
				yield* Effect.addFinalizer(() => Effect.sync(() => terminals.delete(info.id)));
				yield* Deferred.succeed(ready, undefined);
				const exitCode = yield* Effect.promise(() => process.exited);
				// Gone from the list before clients see the exit, so a refresh never shows a dead terminal.
				terminals.delete(info.id);
				publish(terminal, { type: "exit", exitCode });
				yield* Effect.logInfo("Terminal exited").pipe(Effect.annotateLogs({ terminalId: info.id, exitCode }));
			}).pipe(
				Effect.scoped,
				Effect.catchTag("TerminalSpawnError", (error) => Deferred.fail(ready, error)),
			);
			yield* FiberMap.run(fibers, info.id, run);
			yield* Deferred.await(ready);
			yield* Effect.logInfo("Opened terminal").pipe(Effect.annotateLogs({ terminalId: info.id, workspaceId }));
			return info;
		}, Effect.provide(services));

		const find = (terminalId: string) => {
			const terminal = terminals.get(terminalId);
			return terminal === undefined ? Effect.fail(new TerminalNotFoundError({ terminalId })) : Effect.succeed(terminal);
		};

		const list = (workspaceId: string) =>
			[...terminals.values()].map((terminal) => terminal.info).filter((info) => info.workspaceId === workspaceId);

		const attach = (terminalId: string): Stream.Stream<TerminalOutput, TerminalNotFoundError> =>
			Stream.unwrap(
				Effect.gen(function* () {
					const terminal = yield* find(terminalId);
					// Subscribe before taking the snapshot, then skip what the snapshot already holds.
					const subscription = yield* PubSub.subscribe(terminal.output);
					const snapshotIndex = terminal.appended.count;
					const snapshot: TerminalOutput = { type: "data", data: terminal.scrollback.toString() };
					return Stream.concat(
						Stream.succeed(snapshot),
						Stream.fromSubscription(subscription).pipe(
							Stream.filter((item) => item.index > snapshotIndex),
							Stream.map((item) => item.output),
							Stream.takeUntil((output) => output.type === "exit"),
						),
					);
				}),
			);

		const write = (terminalId: string, data: string) =>
			Effect.map(find(terminalId), (terminal) => {
				terminal.pty.write(data);
			});

		const resize = (terminalId: string, size: Size) =>
			Effect.map(find(terminalId), (terminal) => {
				terminal.pty.resize(size.cols, size.rows);
			});

		const close = (terminalId: string) => FiberMap.remove(fibers, terminalId);

		const closeWorkspace = (workspaceId: string) =>
			Effect.forEach(list(workspaceId), (info) => close(info.id), { discard: true });

		return { open, list, attach, write, resize, close, closeWorkspace };
	}),
}) {
	static readonly layer = Layer.effect(TerminalService, TerminalService.make);
}
