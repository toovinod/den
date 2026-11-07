import { describe, expect, test } from "bun:test";
import { sortImports } from "./sortImports.ts";

const lines = (...text: ReadonlyArray<string>) => text.join("\n");

describe("sortImports", () => {
	test("orders imports from the longest to the shortest", () => {
		const source = lines(
			'import { db } from "./db.ts";',
			'import { NextRequest } from "next/server";',
			'import { WorkspaceService } from "@/lib/workspace";',
			"",
			"export const x = 1;",
		);
		expect(sortImports(source)).toBe(
			lines(
				'import { WorkspaceService } from "@/lib/workspace";',
				'import { NextRequest } from "next/server";',
				'import { db } from "./db.ts";',
				"",
				"export const x = 1;",
			),
		);
	});

	test("breaks ties by name, so the order is stable", () => {
		const source = lines('import { b } from "./b.ts";', 'import { a } from "./a.ts";');
		expect(sortImports(source)).toBe(lines('import { a } from "./a.ts";', 'import { b } from "./b.ts";'));
	});

	test("measures a wrapped import by its one-line form", () => {
		const wrapped = lines("import {", "\tveryLongNameNumberOne,", "\tveryLongNameNumberTwo,", '} from "./long.ts";');
		const short = 'import { short } from "./s.ts";';
		expect(sortImports(lines(short, wrapped))).toBe(lines(wrapped, short));
	});

	test("keeps bare imports in place and sorts around them", () => {
		const source = lines(
			'import { a } from "./a.ts";',
			'import { longer } from "./longer.ts";',
			'import "./global.css";',
			'import { b } from "./b.ts";',
			'import { muchLonger } from "./muchLonger.ts";',
		);
		expect(sortImports(source)).toBe(
			lines(
				'import { longer } from "./longer.ts";',
				'import { a } from "./a.ts";',
				'import "./global.css";',
				'import { muchLonger } from "./muchLonger.ts";',
				'import { b } from "./b.ts";',
			),
		);
	});

	test("keeps a leading comment or shebang above the imports", () => {
		const source = lines(
			"#!/usr/bin/env bun",
			"// Entry point.",
			'import { a } from "./a.ts";',
			'import { bb } from "./bb.ts";',
		);
		expect(sortImports(source)).toBe(
			lines("#!/usr/bin/env bun", "// Entry point.", 'import { bb } from "./bb.ts";', 'import { a } from "./a.ts";'),
		);
	});

	test("leaves a file without leading imports unchanged", () => {
		const source = lines("export const x = 1;", 'import { a } from "./a.ts";');
		expect(sortImports(source)).toBe(source);
	});

	test("drops blank lines inside the import block", () => {
		const source = lines('import { a } from "./a.ts";', "", 'import { bb } from "./bb.ts";', "", "const x = 1;");
		expect(sortImports(source)).toBe(
			lines('import { bb } from "./bb.ts";', 'import { a } from "./a.ts";', "", "const x = 1;"),
		);
	});
});
