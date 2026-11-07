// Orders a file's leading imports from the longest to the shortest, so the block reads as a
// staircase. A bare import such as `import "./global.css"` runs code, so it stays where it is
// and only the imports between bare ones are sorted.

const isBareImport = (statement: string) => /^import\s+["']/.test(statement);

// Length as one line, so a statement the formatter wrapped compares like its one-line form.
const oneLineLength = (statement: string) =>
	statement
		.replace(/\s*\n\s*/g, " ")
		.replace(/\{ /g, "{")
		.replace(/,? \}/g, "}").length;

const byLengthThenName = (a: string, b: string) => oneLineLength(b) - oneLineLength(a) || a.localeCompare(b);

const sortRuns = (statements: ReadonlyArray<string>) => {
	const sorted: Array<string> = [];
	let run: Array<string> = [];
	for (const statement of statements) {
		if (isBareImport(statement)) {
			sorted.push(...run.sort(byLengthThenName), statement);
			run = [];
		} else {
			run.push(statement);
		}
	}
	return [...sorted, ...run.sort(byLengthThenName)];
};

const isPreamble = (line: string) =>
	line.trim() === "" || line.startsWith("#!") || line.startsWith("//") || /^\s*(\/\*|\*)/.test(line);

export const sortImports = (source: string): string => {
	const lines = source.split("\n");
	let start = 0;
	while (start < lines.length && !lines[start]?.startsWith("import ") && isPreamble(lines[start] ?? "")) start++;
	if (!lines[start]?.startsWith("import ")) return source;

	// The block ends at the first line that is neither an import nor blank, such as a comment.
	const statements: Array<string> = [];
	let end = start;
	let next = start;
	while (next < lines.length) {
		const line = lines[next] ?? "";
		if (line.trim() === "") {
			next++;
			continue;
		}
		if (!line.startsWith("import ")) break;
		let last = next;
		while (last < lines.length && !lines[last]?.trimEnd().endsWith(";")) last++;
		statements.push(lines.slice(next, last + 1).join("\n"));
		end = last + 1;
		next = last + 1;
	}

	return [...lines.slice(0, start), ...sortRuns(statements), ...lines.slice(end)].join("\n");
};

// `bun run lint` checks the order and `bun run format` fixes it, like Biome does for the rest.
// Biome's force-ignored paths ("!!path") are generated files, so they are skipped here too.
if (import.meta.main) {
	const root = `${import.meta.dir}/..`;
	const biome: { files: { includes: Array<string> } } = await Bun.file(`${root}/biome.json`).json();
	const ignored = biome.files.includes.filter((pattern) => pattern.startsWith("!!")).map((pattern) => pattern.slice(2));
	const listed = await Bun.$`git ls-files --cached --others --exclude-standard ${["*.ts", "*.tsx"]}`.cwd(root).text();
	const files = listed
		.split("\n")
		.filter((file) => file !== "" && !ignored.some((path) => file === path || file.startsWith(`${path}/`)));
	const write = Bun.argv.includes("--write");
	const unsorted: Array<string> = [];
	for (const file of files) {
		const handle = Bun.file(`${root}/${file}`);
		if (!(await handle.exists())) continue;
		const source = await handle.text();
		const sorted = sortImports(source);
		if (sorted === source) continue;
		if (write) await Bun.write(handle, sorted);
		else unsorted.push(file);
	}
	if (unsorted.length > 0) {
		console.error(
			`Imports must go from the longest to the shortest. Run \`bun run format\` to fix:\n${unsorted.join("\n")}`,
		);
		process.exitCode = 1;
	}
}
