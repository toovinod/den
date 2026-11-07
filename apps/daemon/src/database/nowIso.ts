import { DateTime, Effect } from "effect";

// Times are stored as ISO strings.
export const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
