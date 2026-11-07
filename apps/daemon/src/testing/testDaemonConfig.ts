import { DaemonConfig } from "../config/DaemonConfig.ts";
import { Effect, Layer, Redacted } from "effect";

export const TEST_TOKEN = "test-token";

export const testDaemonConfig = (dataDir: string) =>
	Layer.succeed(
		DaemonConfig,
		DaemonConfig.of({ port: 0, token: Redacted.make(TEST_TOKEN), dataDir, parentExited: Effect.never }),
	);
