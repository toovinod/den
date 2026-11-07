import { Config, Context, Effect, Layer, Option, Redacted, Schema, Stdio, Stream } from "effect";
import { homedir } from "node:os";
import { join } from "node:path";

class DaemonTokenMissingError extends Schema.TaggedError<DaemonTokenMissingError>()("DaemonTokenMissingError", {}) {
	override get message() {
		return "swarmd reads its token from the first line of stdin. Start it from the Swarm app.";
	}
}

// The desktop shell writes the token on stdin rather than in the environment, because every
// agent, script and git process the daemon starts inherits its environment.
const readTokenFromStdin = Effect.gen(function* () {
	const stdio = yield* Stdio.Stdio;
	const firstLine = yield* stdio.stdin.pipe(Stream.decodeText(), Stream.splitLines, Stream.runHead, Effect.orDie);
	const token = Option.getOrElse(firstLine, () => "").trim();
	if (token === "") {
		return yield* new DaemonTokenMissingError();
	}
	return Redacted.make(token);
});

export class DaemonConfig extends Context.Service<
	DaemonConfig,
	{
		readonly port: number;
		readonly token: Redacted.Redacted<string>;
		readonly dataDir: string;
	}
>()("swarm/daemon/config/DaemonConfig") {
	static readonly layer = Layer.effect(
		DaemonConfig,
		Effect.gen(function* () {
			const port = yield* Config.Port("SWARM_DAEMON_PORT").pipe(Config.withDefault(0));
			const token = yield* readTokenFromStdin;
			const dataDir = yield* Config.String("SWARM_DATA_DIR").pipe(Config.withDefault(join(homedir(), ".swarm")));
			return DaemonConfig.of({ port, token, dataDir });
		}),
	);
}
