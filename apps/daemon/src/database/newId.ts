import { Effect } from "effect";
import { SecureRandom } from "effect/crypto";

// Row IDs are UUIDv7 text, so they sort by creation time.
export const newId = Effect.flatMap(SecureRandom.SecureRandom, (random) =>
	random.uuidV7(),
);
