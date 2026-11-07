import { stopProcessGroup } from "../processes/stopProcessGroup.ts";
import { ProcessRegistry } from "../processes/ProcessRegistry.ts";
import { TerminalSpawnError } from "@repo/contracts/Terminal";
import { Effect } from "effect";

// A shell on a PTY, in its own process group and session. Closing the scope sends SIGHUP to the
// whole group, then SIGKILL after the grace. Signalling only the shell is not enough: on Linux
// the PTY does not become the shell's controlling terminal, so nothing else hangs up its children.
export const spawnTerminal = Effect.fn("spawnTerminal")(function* (options: {
	readonly command: readonly [string, ...Array<string>];
	readonly cwd: string;
	readonly cols: number;
	readonly rows: number;
	readonly onData: (data: Uint8Array) => void;
}) {
	const registry = yield* ProcessRegistry;
	const { terminal, shell } = yield* Effect.acquireRelease(
		Effect.try({
			try: () => {
				const terminal = new Bun.Terminal({
					cols: options.cols,
					rows: options.rows,
					data: (_terminal, data) => options.onData(data),
				});
				const shell = Bun.spawn([...options.command], { cwd: options.cwd, terminal, detached: true });
				return { terminal, shell };
			},
			catch: (cause) => new TerminalSpawnError({ shell: options.command[0], cause }),
		}),
		({ terminal, shell }) =>
			Effect.gen(function* () {
				yield* stopProcessGroup(shell.pid, { signal: "SIGHUP" });
				terminal.close();
				yield* registry.remove(shell.pid);
			}),
	);
	yield* registry.add(shell.pid);
	return { terminal, exited: Effect.promise(() => shell.exited) };
});
