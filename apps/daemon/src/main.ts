import { BunRuntime, BunStdio } from "@effect/platform-bun";
import { Layer } from "effect";
import { DaemonConfig } from "./config/DaemonConfig.ts";
import { DaemonServer } from "./server/DaemonServer.ts";

const DaemonLayer = DaemonServer.pipe(Layer.provide(DaemonConfig.layer), Layer.provide(BunStdio.layer));

BunRuntime.runMain(Layer.launch(DaemonLayer));
