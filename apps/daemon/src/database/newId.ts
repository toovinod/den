import { Effect } from "effect";
import { SecureRandom } from "effect/crypto";

export const newId = Effect.flatMap(SecureRandom.SecureRandom, (random) =>
	random.uuidV7(),
);
