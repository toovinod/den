import { Config, Context, Effect, Layer, Option, Redacted, Schema, Sink, Stdio, Stream } from "effect";
import { homedir } from "node:os";
import { join } from "node:path";

class DaemonTokenMissingError extends Schema.TaggedError<DaemonTokenMissingError>()("DaemonTokenMissingError", {}) {
	override get message() {
		return "dend reads its token from the first line of stdin. Start it from the Den app.";
	}
}

// The desktop shell writes the token on stdin rather than in the environment, because every
// agent, script and git process the daemon starts inherits its environment. It keeps stdin open
// afterwards, and the OS closes it when the shell exits for any reason, including a crash.
const readStdin = Effect.gen(function* () {
	const stdio = yield* Stdio.Stdio;
	const [firstLine, rest] = yield* stdio.stdin.pipe(
		Stream.decodeText(),
		Stream.splitLines,
		Stream.peel(Sink.head()),
		Effect.orDie,
	);
	const token = Option.getOrElse(firstLine, () => "").trim();
	if (token === "") {
		return yield* new DaemonTokenMissingError();
	}
	return { token: Redacted.make(token), parentExited: Effect.orDie(Stream.runDrain(rest)) };
});

export class DaemonConfig extends Context.Service<
	DaemonConfig,
	{
		readonly port: number;
		readonly token: Redacted.Redacted<string>;
		readonly dataDir: string;
		// Completes when stdin closes, which means the app that started the daemon is gone.
		readonly parentExited: Effect.Effect<void>;
	}
>()("den/daemon/config/DaemonConfig") {
	static readonly layer = Layer.effect(
		DaemonConfig,
		Effect.gen(function* () {
			const port = yield* Config.Port("DEN_DAEMON_PORT").pipe(Config.withDefault(0));
			const { token, parentExited } = yield* readStdin;
			const dataDir = yield* Config.String("DEN_DATA_DIR").pipe(Config.withDefault(join(homedir(), ".den")));
			return DaemonConfig.of({ port, token, dataDir, parentExited });
		}),
	);
}
