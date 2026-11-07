import { ProcessRegistry } from "../processes/ProcessRegistry.ts";
import { Effect, Layer } from "effect";

// For tests whose children never outlive the test.
export const testProcessRegistry = Layer.succeed(
	ProcessRegistry,
	ProcessRegistry.of({ add: () => Effect.void, remove: () => Effect.void }),
);
