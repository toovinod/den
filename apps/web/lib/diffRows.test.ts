import { diffRows, startsOpen, wordDiff } from "./diffRows.ts";
import { describe, expect, test } from "bun:test";
import { DiffFile } from "@repo/contracts/Git";

const file = new DiffFile({
	path: "a.ts",
	oldPath: null,
	status: "modified",
	additions: 2,
	deletions: 1,
	content: {
		kind: "text",
		hunks: [
			{
				header: "@@ -1,2 +1,3 @@",
				lines: [
					{ kind: "context", oldLine: 1, newLine: 1, text: "const a = 1;" },
					{ kind: "delete", oldLine: 2, newLine: null, text: "const b = 2;" },
					{ kind: "add", oldLine: null, newLine: 2, text: "const b = 3;" },
					{ kind: "add", oldLine: null, newLine: 3, text: "const c = 4;" },
				],
			},
		],
	},
});

describe("wordDiff", () => {
	test("marks only the tokens that changed", () => {
		expect(wordDiff("const b = 2;", "const b = 3;")).toEqual({
			before: [
				{ text: "const b = ", changed: false },
				{ text: "2", changed: true },
				{ text: ";", changed: false },
			],
			after: [
				{ text: "const b = ", changed: false },
				{ text: "3", changed: true },
				{ text: ";", changed: false },
			],
		});
	});
});

describe("diffRows", () => {
	test("unified rows highlight words only on paired lines", () => {
		const rows = diffRows([file], "unified", () => true);
		expect(rows.map((row) => row.type)).toEqual(["file", "hunk", "line", "line", "line", "line"]);
		const segments = rows.map((row) => (row.type === "line" ? row.segments !== null : null));
		expect(segments).toEqual([null, null, false, true, true, false]);
	});

	test("split rows put an edit beside its removal and a lone addition on the right", () => {
		const rows = diffRows([file], "split", () => true).filter((row) => row.type === "pair");
		expect(rows.map((row) => [row.left?.text ?? null, row.right?.text ?? null])).toEqual([
			["const a = 1;", "const a = 1;"],
			["const b = 2;", "const b = 3;"],
			[null, "const c = 4;"],
		]);
	});

	test("a closed file shows only its header, and large files start closed", () => {
		expect(diffRows([file], "unified", () => false)).toHaveLength(1);
		expect(startsOpen(file)).toBe(true);
		expect(startsOpen(new DiffFile({ ...file, additions: 900 }))).toBe(false);
	});
});
