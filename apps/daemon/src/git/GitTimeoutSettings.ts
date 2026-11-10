import { GitTimeoutError } from "@repo/contracts/Git";
import { Context, Duration, Effect } from "effect";

export const GitTimeoutSettings = Context.Reference<{
	// How long a git or gh command may run before it is killed. A hung command (a credential
	// helper waiting for input, a stalled network) would otherwise hold its request forever.
	readonly local: Duration.Duration;
	// For commands that talk to a remote. Every gh command does.
	readonly network: Duration.Duration;
}>("den/daemon/git/GitTimeoutSettings", {
	defaultValue: () => ({ local: Duration.minutes(2), network: Duration.minutes(5) }),
});

// Wraps a scoped command, so the timeout closes its scope and the spawner kills the process group.
export const withGitDeadline =
	(command: string, kind: GitTimeoutError["kind"]) =>
	<A, E, R>(effect: Effect.Effect<A, E, R>) =>
		Effect.flatMap(GitTimeoutSettings, (settings) =>
			effect.pipe(
				Effect.timeoutOrElse({
					duration: settings[kind],
					orElse: () => {
						const error = new GitTimeoutError({ command, kind, timeout: Duration.format(settings[kind]) });
						return Effect.logWarning("Stopped a command that ran past its deadline", error).pipe(
							Effect.andThen(Effect.fail(error)),
						);
					},
				}),
			),
		);
