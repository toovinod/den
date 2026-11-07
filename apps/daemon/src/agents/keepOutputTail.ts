// Tool output can be huge. Events keep only the tail, which holds the result and any error.
const MAX_OUTPUT_CHARS = 16_000;

export const keepOutputTail = (output: string): string =>
	output.length > MAX_OUTPUT_CHARS ? output.slice(-MAX_OUTPUT_CHARS) : output;
