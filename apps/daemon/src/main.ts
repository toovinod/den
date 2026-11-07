import { BunRuntime, BunStdio } from "@effect/platform-bun";
import { AgentServices } from "./server/DaemonServices.ts";
import { DaemonConfig } from "./config/DaemonConfig.ts";
import { DaemonServer } from "./server/DaemonServer.ts";
import { Layer } from "effect";

const DaemonLayer = DaemonServer.pipe(
	Layer.provide([DaemonConfig.layer, AgentServices]),
	Layer.provide(BunStdio.layer),
);

BunRuntime.runMain(Layer.launch(DaemonLayer));
