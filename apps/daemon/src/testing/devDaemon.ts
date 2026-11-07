import { FakeSessionRpcHandlers } from "./FakeSessionRpcHandlers.ts";
import { CoreRpcHandlers } from "../rpc/DaemonRpcHandlers.ts";
import { makeDaemonServer } from "../server/DaemonServer.ts";
import { BunRuntime, BunStdio } from "@effect/platform-bun";
import { DaemonConfig } from "../config/DaemonConfig.ts";
import { Layer } from "effect";

// The real daemon with fake agent sessions, for UI work until SessionService lands.
// Run it with `bun run dev:fake` and type a token on the first line, as the desktop shell does.
const DevDaemonLayer = makeDaemonServer(Layer.merge(CoreRpcHandlers, FakeSessionRpcHandlers)).pipe(
	Layer.provide(DaemonConfig.layer),
	Layer.provide(BunStdio.layer),
);

BunRuntime.runMain(Layer.launch(DevDaemonLayer));
