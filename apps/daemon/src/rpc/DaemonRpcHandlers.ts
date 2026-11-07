import { DaemonHealth, DaemonRpcs } from "@repo/contracts/DaemonRpcs";
import { Effect } from "effect";
import packageJson from "../../package.json" with { type: "json" };

export const DaemonRpcHandlers = DaemonRpcs.toLayer({
	health: () =>
		Effect.succeed(new DaemonHealth({ version: packageJson.version })),
});
