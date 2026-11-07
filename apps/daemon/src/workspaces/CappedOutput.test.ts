import { CappedOutput, OUTPUT_MAX_BYTES, OUTPUT_MAX_LINES } from "./CappedOutput.ts";
import { describe, expect, test } from "bun:test";

describe("CappedOutput", () => {
	test("keeps everything under both caps", () => {
		const output = new CappedOutput();
		output.append("one");
		output.append("two");
		expect(output.toString()).toBe("one\ntwo");
	});

	test("keeps the last 2,000 lines when lines are short", () => {
		const output = new CappedOutput();
		for (let line = 0; line < OUTPUT_MAX_LINES + 500; line++) {
			output.append(`line ${line}`);
		}
		const lines = output.toString().split("\n");
		expect(lines).toHaveLength(OUTPUT_MAX_LINES);
		expect(lines[0]).toBe("line 500");
		expect(lines.at(-1)).toBe(`line ${OUTPUT_MAX_LINES + 499}`);
	});

	test("keeps the last 64 KB when lines are long", () => {
		const output = new CappedOutput();
		const longLine = "x".repeat(1000);
		for (let line = 0; line < 100; line++) {
			output.append(`${line}:${longLine}`);
		}
		const text = output.toString();
		expect(new TextEncoder().encode(text).length).toBeLessThanOrEqual(OUTPUT_MAX_BYTES);
		expect(text.split("\n").at(-1)).toBe(`99:${longLine}`);
		expect(text.startsWith("0:")).toBe(false);
	});

	test("keeps the end of a single line larger than the byte cap", () => {
		const output = new CappedOutput();
		output.append(`start${"y".repeat(OUTPUT_MAX_BYTES)}end`);
		const text = output.toString();
		expect(text).toHaveLength(OUTPUT_MAX_BYTES);
		expect(text.endsWith("end")).toBe(true);
	});
});
