export const SCROLLBACK_MAX_LINES = 5000;
export const SCROLLBACK_MAX_BYTES = 2 * 1024 * 1024;

const countLines = (text: string) => {
	let lines = 0;
	for (let index = text.indexOf("\n"); index !== -1; index = text.indexOf("\n", index + 1)) {
		lines++;
	}
	return lines;
};

// What a terminal keeps for clients that attach later. Raw PTY output, so it is capped by
// newlines and bytes rather than split into lines.
export class Scrollback {
	private readonly chunks: Array<{ text: string; lines: number; bytes: number }> = [];
	private lines = 0;
	private bytes = 0;

	append(text: string): void {
		const chunk = { text, lines: countLines(text), bytes: Buffer.byteLength(text) };
		this.chunks.push(chunk);
		this.lines += chunk.lines;
		this.bytes += chunk.bytes;
		while (this.chunks.length > 1 && this.isOverCap()) {
			const dropped = this.chunks.shift();
			this.lines -= dropped?.lines ?? 0;
			this.bytes -= dropped?.bytes ?? 0;
		}
		const [only] = this.chunks;
		if (this.chunks.length === 1 && only !== undefined && this.isOverCap()) {
			this.chunks[0] = this.trimHead(only.text);
			this.lines = this.chunks[0].lines;
			this.bytes = this.chunks[0].bytes;
		}
	}

	toString(): string {
		return this.chunks.map((chunk) => chunk.text).join("");
	}

	private isOverCap() {
		return this.lines > SCROLLBACK_MAX_LINES || this.bytes > SCROLLBACK_MAX_BYTES;
	}

	// One huge chunk keeps only its last lines, within the byte cap.
	private trimHead(text: string) {
		const kept = text.split("\n").slice(-SCROLLBACK_MAX_LINES).join("\n");
		const bytes = Buffer.from(kept);
		const fitted =
			bytes.length > SCROLLBACK_MAX_BYTES ? new TextDecoder().decode(bytes.subarray(-SCROLLBACK_MAX_BYTES)) : kept;
		return { text: fitted, lines: countLines(fitted), bytes: Buffer.byteLength(fitted) };
	}
}
