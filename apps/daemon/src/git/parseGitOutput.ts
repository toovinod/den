import type { DiffFileStatus, DiffHunk, DiffLine } from "@repo/contracts/Git";

// Parsers for git's machine-readable output. Every command that feeds them runs with -z, so paths
// arrive unquoted and NUL-separated.

export interface ChangedPath {
	readonly path: string;
	readonly oldPath: string | null;
	readonly status: DiffFileStatus;
}

const statusFromLetter = (letter: string): DiffFileStatus => {
	switch (letter) {
		case "A":
			return "added";
		case "D":
			return "deleted";
		case "R":
		case "C":
			return "renamed";
		default:
			return "modified";
	}
};

// `git diff --name-status -z`: "M\0path\0", or "R100\0old\0new\0" for renames and copies.
export const parseNameStatus = (output: string): ReadonlyArray<ChangedPath> => {
	const tokens = output.split("\0").filter((token) => token !== "");
	const changed: Array<ChangedPath> = [];
	for (let index = 0; index < tokens.length; ) {
		const letter = tokens[index]?.charAt(0) ?? "";
		if (letter === "R" || letter === "C") {
			changed.push({ oldPath: tokens[index + 1] ?? "", path: tokens[index + 2] ?? "", status: "renamed" });
			index += 3;
		} else {
			changed.push({ oldPath: null, path: tokens[index + 1] ?? "", status: statusFromLetter(letter) });
			index += 2;
		}
	}
	return changed;
};

export interface LineCounts {
	readonly additions: number;
	readonly deletions: number;
	readonly binary: boolean;
}

// `git diff --numstat -z`: "1\t2\tpath\0", or "1\t2\t\0old\0new\0" for renames. Binary files count "-".
export const parseNumstat = (output: string): ReadonlyMap<string, LineCounts> => {
	const tokens = output.split("\0");
	const counts = new Map<string, LineCounts>();
	for (let index = 0; index < tokens.length; index++) {
		const match = /^(\d+|-)\t(\d+|-)\t(.*)$/s.exec(tokens[index] ?? "");
		if (match === null) {
			continue;
		}
		const [, added = "-", deleted = "-", inlinePath = ""] = match;
		let path = inlinePath;
		if (path === "") {
			path = tokens[index + 2] ?? "";
			index += 2;
		}
		counts.set(path, {
			additions: added === "-" ? 0 : Number(added),
			deletions: deleted === "-" ? 0 : Number(deleted),
			binary: added === "-",
		});
	}
	return counts;
};

export interface PatchSection {
	readonly binary: boolean;
	readonly hunks: ReadonlyArray<DiffHunk>;
}

const HUNK_HEADER = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

// A unified diff from `git diff`, one section per "diff --git" header, in git's order.
export const parsePatch = (patch: string): ReadonlyArray<PatchSection> => {
	const sections: Array<{ binary: boolean; hunks: Array<{ header: string; lines: Array<DiffLine> }> }> = [];
	let oldLine = 0;
	let newLine = 0;
	for (const line of patch.split("\n")) {
		if (line.startsWith("diff --git ")) {
			sections.push({ binary: false, hunks: [] });
			continue;
		}
		const section = sections.at(-1);
		if (section === undefined) {
			continue;
		}
		const header = HUNK_HEADER.exec(line);
		if (header !== null) {
			oldLine = Number(header[1]);
			newLine = Number(header[2]);
			section.hunks.push({ header: line, lines: [] });
			continue;
		}
		const hunk = section.hunks.at(-1);
		if (hunk === undefined) {
			if (line.startsWith("Binary files ") || line === "GIT binary patch") {
				section.binary = true;
			}
			continue;
		}
		const marker = line.charAt(0);
		const text = line.slice(1);
		if (marker === "+") {
			hunk.lines.push({ kind: "add", oldLine: null, newLine: newLine++, text });
		} else if (marker === "-") {
			hunk.lines.push({ kind: "delete", oldLine: oldLine++, newLine: null, text });
		} else if (marker === " ") {
			hunk.lines.push({ kind: "context", oldLine: oldLine++, newLine: newLine++, text });
		}
		// "\ No newline at end of file" and the trailing empty line carry no content.
	}
	return sections;
};

// A new, untracked file shown as one hunk of additions.
export const untrackedHunks = (text: string): ReadonlyArray<DiffHunk> => {
	if (text === "") {
		return [];
	}
	const lines = text.endsWith("\n") ? text.slice(0, -1).split("\n") : text.split("\n");
	return [
		{
			header: `@@ -0,0 +1,${lines.length} @@`,
			lines: lines.map((line, index) => ({ kind: "add", oldLine: null, newLine: index + 1, text: line })),
		},
	];
};

export interface BranchStatus {
	readonly branch: string;
	readonly upstream: string | null;
	readonly ahead: number;
	readonly behind: number;
	readonly changedFiles: number;
}

// `git status --porcelain=v2 --branch -z`.
export const parseStatus = (output: string): BranchStatus => {
	const tokens = output.split("\0").filter((token) => token !== "");
	let branch = "HEAD";
	let upstream: string | null = null;
	let ahead = 0;
	let behind = 0;
	let changedFiles = 0;
	for (let index = 0; index < tokens.length; index++) {
		const token = tokens[index] ?? "";
		if (token.startsWith("# branch.head ")) {
			const head = token.slice("# branch.head ".length);
			branch = head === "(detached)" ? "HEAD" : head;
		} else if (token.startsWith("# branch.upstream ")) {
			upstream = token.slice("# branch.upstream ".length);
		} else if (token.startsWith("# branch.ab ")) {
			const [aheadText = "+0", behindText = "-0"] = token.slice("# branch.ab ".length).split(" ");
			ahead = Number(aheadText.slice(1));
			behind = Number(behindText.slice(1));
		} else if (!token.startsWith("#")) {
			changedFiles++;
			// A rename entry is followed by its original path.
			if (token.startsWith("2 ")) {
				index++;
			}
		}
	}
	return { branch, upstream, ahead, behind, changedFiles };
};
