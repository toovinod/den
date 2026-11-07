import { DateTime, Effect } from "effect";

export const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
