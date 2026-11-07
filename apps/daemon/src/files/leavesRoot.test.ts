import { describe, expect, test } from "bun:test";
import { leavesRoot } from "./leavesRoot.ts";

describe("leavesRoot", () => {
	test("refuses a path above the folder or outside it", () => {
		expect(leavesRoot("..")).toBe(true);
		expect(leavesRoot("../secret")).toBe(true);
		expect(leavesRoot("/etc/passwd")).toBe(true);
	});

	test("allows names that only start with two dots", () => {
		expect(leavesRoot("..env")).toBe(false);
		expect(leavesRoot("src/..hidden/a.ts")).toBe(false);
		expect(leavesRoot("src/a.ts")).toBe(false);
	});
});
