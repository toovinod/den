import { Stream } from "effect";

// Small enough that a cut line, even at 3 UTF-8 bytes per character, fits CappedOutput's budget.
export const LINE_MAX_LENGTH = 16 * 1024;

const LINE_BREAK = /(\r|\n)/;

// Goes before Stream.splitLines, which holds a line until its line break arrives: a script that
// prints megabytes without one would grow the daemon by as much. Each line keeps its first
// LINE_MAX_LENGTH characters and the rest is dropped as it arrives. Line breaks pass through, so
// splitLines still decides where lines end.
export const capLineLength = <E, R>(text: Stream.Stream<string, E, R>): Stream.Stream<string, E, R> =>
	text.pipe(
		Stream.mapAccum(
			() => 0,
			(lineLength, chunk: string) => {
				let kept = "";
				let length = lineLength;
				for (const part of chunk.split(LINE_BREAK)) {
					if (LINE_BREAK.test(part)) {
						kept += part;
						length = 0;
					} else {
						kept += part.slice(0, Math.max(0, LINE_MAX_LENGTH - length));
						length += part.length;
					}
				}
				return [length, kept === "" ? [] : [kept]];
			},
		),
	);
