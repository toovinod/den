import type { TerminalOutput } from "@repo/contracts/Terminal";
import { errorTag, type Follow } from "./daemonRuntime.ts";

export interface TerminalScreen {
	readonly reset: () => void;
	readonly write: (data: string) => void;
}

const RECONNECT_DELAY_MS = 1000;

const note = (text: string) => `\r\n\x1b[2m[${text}]\x1b[0m\r\n`;

// Keeps a terminal view attached to its PTY while the PTY runs. A dropped connection reattaches, and because every
// attach starts with the daemon's scrollback, the screen is cleared first so the output shows once.
export const followTerminal = (
	attach: (follow: Follow<TerminalOutput>) => () => void,
	screen: TerminalScreen,
): (() => void) => {
	let stopped = false;
	let stopAttach = () => {};
	let retry: ReturnType<typeof setTimeout> | undefined;
	const start = () => {
		let replayed = false;
		stopAttach = attach({
			onItem: (output) => {
				if (output.type === "exit") {
					screen.write(note(`The shell exited${output.exitCode === null ? "" : ` with code ${output.exitCode}`}`));
					return;
				}
				if (!replayed) {
					replayed = true;
					screen.reset();
				}
				screen.write(output.data);
			},
			// The stream finishes on its own only after the exit, which onItem already showed.
			onEnd: (error) => {
				if (stopped || error === null) return;
				// The shell exited while we were away, or the daemon restarted without it.
				if (errorTag(error) === "TerminalNotFoundError") {
					screen.write(note("This terminal has closed. Open a new one."));
					return;
				}
				screen.write(note("Disconnected. Reconnecting"));
				retry = setTimeout(start, RECONNECT_DELAY_MS);
			},
		});
	};
	start();
	return () => {
		stopped = true;
		clearTimeout(retry);
		stopAttach();
	};
};
