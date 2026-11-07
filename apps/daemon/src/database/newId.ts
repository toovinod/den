import { SecureRandom } from "effect/crypto";
import { Effect } from "effect";

export const newId = Effect.flatMap(SecureRandom.SecureRandom, (random) => random.uuidV7());
