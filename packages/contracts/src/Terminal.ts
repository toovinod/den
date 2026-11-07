import { Schema } from "effect";

export class TerminalInfo extends Schema.Class<TerminalInfo>("TerminalInfo")({
	id: Schema.String,
	workspaceId: Schema.String,
	title: Schema.String,
	createdAt: Schema.String,
}) {}

// Attaching sends the kept scrollback as the first data event, then live output.
export const TerminalOutput = Schema.Union([
	Schema.Struct({ type: Schema.Literal("data"), data: Schema.String }),
	Schema.Struct({ type: Schema.Literal("exit"), exitCode: Schema.NullOr(Schema.Int) }),
]);
export type TerminalOutput = typeof TerminalOutput.Type;

export const TerminalSize = {
	cols: Schema.Int.check(Schema.isBetween({ minimum: 2, maximum: 1000 })),
	rows: Schema.Int.check(Schema.isBetween({ minimum: 2, maximum: 1000 })),
};

export class TerminalNotFoundError extends Schema.TaggedError<TerminalNotFoundError>()("TerminalNotFoundError", {
	terminalId: Schema.String,
}) {
	override get message() {
		return "This terminal has closed. Open a new one.";
	}
}

export class TerminalSpawnError extends Schema.TaggedError<TerminalSpawnError>()("TerminalSpawnError", {
	shell: Schema.String,
	cause: Schema.Defect(),
}) {
	override get message() {
		return `Swarm could not start ${this.shell}. Check that your login shell exists.`;
	}
}
