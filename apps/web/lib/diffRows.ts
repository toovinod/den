import type { DiffFile, DiffLine } from "@repo/contracts/Git";

export interface Segment {
	readonly text: string;
	readonly changed: boolean;
}

const tokenize = (text: string) => text.match(/\w+|\s+|[^\w\s]/g) ?? [];

// Marks what changed between a removed line and the added line that replaced it. Trimming the common
// tokens from both ends is linear, so it stays fast on long lines and still finds the usual one edit.
export const wordDiff = (before: string, after: string) => {
	const a = tokenize(before);
	const b = tokenize(after);
	let start = 0;
	while (start < a.length && start < b.length && a[start] === b[start]) start++;
	let end = 0;
	while (end < a.length - start && end < b.length - start && a[a.length - 1 - end] === b[b.length - 1 - end]) end++;
	const segments = (tokens: ReadonlyArray<string>): ReadonlyArray<Segment> =>
		[
			{ text: tokens.slice(0, start).join(""), changed: false },
			{ text: tokens.slice(start, tokens.length - end).join(""), changed: true },
			{ text: tokens.slice(tokens.length - end).join(""), changed: false },
		].filter((segment) => segment.text !== "");
	return { before: segments(a), after: segments(b) };
};

export type DiffRow =
	| { readonly type: "file"; readonly file: DiffFile; readonly open: boolean }
	| { readonly type: "hunk"; readonly key: string; readonly header: string }
	| {
			readonly type: "line";
			readonly key: string;
			readonly line: DiffLine;
			readonly segments: ReadonlyArray<Segment> | null;
	  }
	| {
			readonly type: "pair";
			readonly key: string;
			readonly left: DiffLine | null;
			readonly right: DiffLine | null;
			readonly leftSegments: ReadonlyArray<Segment> | null;
			readonly rightSegments: ReadonlyArray<Segment> | null;
	  }
	| { readonly type: "notice"; readonly key: string; readonly path: string; readonly reason: "tooLarge" | "binary" };

// Files with more changed lines than this start collapsed, so one generated file cannot stall the list.
export const LARGE_FILE_LINES = 800;

export const startsOpen = (file: DiffFile) => file.additions + file.deletions <= LARGE_FILE_LINES;

// A run of removed lines followed by added lines is an edit: the n-th removal pairs with the n-th addition.
const pairEdits = (lines: ReadonlyArray<DiffLine>) => {
	const partner = new Map<number, number>();
	let index = 0;
	while (index < lines.length) {
		if (lines[index]?.kind !== "delete") {
			index++;
			continue;
		}
		const deletesStart = index;
		while (lines[index]?.kind === "delete") index++;
		const addsStart = index;
		while (lines[index]?.kind === "add") index++;
		const pairs = Math.min(addsStart - deletesStart, index - addsStart);
		for (let offset = 0; offset < pairs; offset++) {
			partner.set(deletesStart + offset, addsStart + offset);
			partner.set(addsStart + offset, deletesStart + offset);
		}
	}
	return partner;
};

export const diffRows = (
	files: ReadonlyArray<DiffFile>,
	mode: "unified" | "split",
	isOpen: (file: DiffFile) => boolean,
): ReadonlyArray<DiffRow> => {
	const rows: Array<DiffRow> = [];
	for (const file of files) {
		const open = isOpen(file);
		rows.push({ type: "file", file, open });
		if (!open) continue;
		const { content } = file;
		if (content.kind !== "text") {
			rows.push({ type: "notice", key: `${file.path}:notice`, path: file.path, reason: content.kind });
			continue;
		}
		for (const [hunkIndex, hunk] of content.hunks.entries()) {
			const prefix = `${file.path}:${hunkIndex}`;
			rows.push({ type: "hunk", key: prefix, header: hunk.header });
			const partner = pairEdits(hunk.lines);
			const segmentsOf = (index: number) => {
				const other = partner.get(index);
				const line = hunk.lines[index];
				const otherLine = other === undefined ? undefined : hunk.lines[other];
				if (line === undefined || otherLine === undefined) return null;
				return line.kind === "delete"
					? wordDiff(line.text, otherLine.text).before
					: wordDiff(otherLine.text, line.text).after;
			};
			if (mode === "unified") {
				for (const [index, line] of hunk.lines.entries()) {
					rows.push({ type: "line", key: `${prefix}:${index}`, line, segments: segmentsOf(index) });
				}
				continue;
			}
			for (const [index, line] of hunk.lines.entries()) {
				const other = partner.get(index);
				if (line.kind === "context") {
					rows.push({
						type: "pair",
						key: `${prefix}:${index}`,
						left: line,
						right: line,
						leftSegments: null,
						rightSegments: null,
					});
				} else if (line.kind === "delete") {
					const right = other === undefined ? null : (hunk.lines[other] ?? null);
					rows.push({
						type: "pair",
						key: `${prefix}:${index}`,
						left: line,
						right,
						leftSegments: segmentsOf(index),
						rightSegments: other === undefined ? null : segmentsOf(other),
					});
				} else if (other === undefined) {
					// Additions with a partner were already shown beside their removal.
					rows.push({
						type: "pair",
						key: `${prefix}:${index}`,
						left: null,
						right: line,
						leftSegments: null,
						rightSegments: null,
					});
				}
			}
		}
	}
	return rows;
};
