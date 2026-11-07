import { DateTime, Option } from "effect";

export const formatTokens = (tokens: number) => (tokens >= 1000 ? `${Math.round(tokens / 1000)}k` : String(tokens));

// "6:00 PM" in the viewer's time zone, or null when the daemon sent something that is not a time.
export const formatClockTime = (iso: string) =>
	DateTime.make(iso).pipe(Option.map(DateTime.formatLocal({ hour: "numeric", minute: "2-digit" })), Option.getOrNull);

// "Mar 4, 6:00 PM", for comments and reviews.
export const formatDateTime = (iso: string) =>
	DateTime.make(iso).pipe(
		Option.map(DateTime.formatLocal({ month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })),
		Option.getOrElse(() => iso),
	);
