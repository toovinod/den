import { homedir } from "node:os";
import { join } from "node:path";
import { Config, Context, Effect, Layer, type Redacted } from "effect";

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
			const port = yield* Config.Port("SWARM_DAEMON_PORT").pipe(
				Config.withDefault(0),
			);
			const token = yield* Config.Redacted("SWARM_DAEMON_TOKEN");
			const dataDir = yield* Config.String("SWARM_DATA_DIR").pipe(
				Config.withDefault(join(homedir(), ".swarm")),
			);
			return DaemonConfig.of({ port, token, dataDir });
		}),
	);
}
