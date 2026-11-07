import { DateTime } from "effect";

// Both agents report reset times as Unix seconds.
export const epochSecondsToIso = (seconds: number) => DateTime.formatIso(DateTime.makeUnsafe(seconds * 1000));
