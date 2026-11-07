const encoder = new TextEncoder();

export const OUTPUT_MAX_BYTES = 64 * 1024;
export const OUTPUT_MAX_LINES = 2000;

// Keeps the last lines of a script's output, within both a byte and a line budget.
// Raw output never goes to the database, and this is all we hold in memory.
export class CappedOutput {
	private readonly lines: Array<{ text: string; bytes: number }> = [];
	private bytes = 0;

	append(line: string): void {
		const text = this.fitLine(line);
		// The newline that joins lines counts toward the budget too.
		const entry = { text, bytes: encoder.encode(text).length + 1 };
		this.lines.push(entry);
		this.bytes += entry.bytes;
		while (
			this.lines.length > OUTPUT_MAX_LINES ||
			this.bytes > OUTPUT_MAX_BYTES + 1
		) {
			const dropped = this.lines.shift();
			this.bytes -= dropped?.bytes ?? 0;
		}
	}

	toString(): string {
		return this.lines.map((line) => line.text).join("\n");
	}

	// A single line longer than the whole budget keeps only its end.
	private fitLine(line: string): string {
		const bytes = encoder.encode(line);
		if (bytes.length <= OUTPUT_MAX_BYTES) {
			return line;
		}
		return new TextDecoder().decode(bytes.slice(-OUTPUT_MAX_BYTES));
	}
}
