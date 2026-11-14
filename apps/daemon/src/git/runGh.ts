import { GhNotAuthenticatedError, GhNotInstalledError } from "@repo/contracts/Git";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { withGitDeadline } from "./GitTimeoutSettings.ts";
import { Context, Effect, Schema, Stream } from "effect";

export const GhSettings = Context.Reference<{ readonly executable: string }>("octopus/daemon/git/GhSettings", {
	defaultValue: () => ({ executable: "gh" }),
});

export class GhCommandError extends Schema.TaggedError<GhCommandError>()("GhCommandError", {
	args: Schema.Array(Schema.String),
	exitCode: Schema.Int,
	stderr: Schema.String,
}) {}

// gh keeps and uses its own GitHub login. Octopus never reads or stores that token.
export const runGh = Effect.fn("runGh")(
	function* (cwd: string, args: ReadonlyArray<string>) {
		const { executable } = yield* GhSettings;
		const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
		const handle = yield* spawner.spawn(
			ChildProcess.make(executable, args, {
				cwd,
				env: { GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1", GIT_TERMINAL_PROMPT: "0" },
				extendEnv: true,
				// After a timeout, a process that ignores SIGTERM must not hold the request either.
				forceKillAfter: "2 seconds",
			}),
		);
		const [stdout, stderr, exitCode] = yield* Effect.all(
			[
				Stream.mkString(Stream.decodeText(handle.stdout)),
				Stream.mkString(Stream.decodeText(handle.stderr)),
				handle.exitCode,
			],
			{ concurrency: "unbounded" },
		);
		if (exitCode !== 0) {
			return yield* new GhCommandError({ args: [...args], exitCode, stderr: stderr.trim() });
		}
		return stdout.trim();
	},
	Effect.scoped,
	(effect, _cwd, args) =>
		effect.pipe(
			withGitDeadline(`gh ${args[0] ?? ""}`, "network"),
			Effect.catchTag("PlatformError", (cause) =>
				Effect.logWarning("Could not start gh", cause).pipe(Effect.andThen(Effect.fail(new GhNotInstalledError()))),
			),
		),
);

// Called after a gh command failed, to tell a missing login apart from other failures.
export const requireGhLogin = (cwd: string) =>
	runGh(cwd, ["auth", "status"]).pipe(
		Effect.asVoid,
		Effect.catchTag("GhCommandError", () => Effect.fail(new GhNotAuthenticatedError())),
	);
