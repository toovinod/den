import type { Follow } from "./daemonRuntime.ts";

const REATTACH_DELAY_MS = 1000;

// Follows a stream the daemon replays from the start on every attach, such as a script run's kept
// output. When the connection drops, it attaches to the same stream again; `onReattach` runs first, so
// the caller can drop what the replay repeats. `onEnd` runs only when the stream itself ends.
export const followReattaching = <A>(
	follow: (handlers: Follow<A>) => () => void,
	handlers: Follow<A> & { readonly onReattach: () => void },
): (() => void) => {
	let stop: () => void = () => undefined;
	let retry: ReturnType<typeof setTimeout> | undefined;
	const attach = () => {
		stop = follow({
			onItem: handlers.onItem,
			onEnd: (error) => {
				if (error === null) {
					handlers.onEnd?.(null);
					return;
				}
				retry = setTimeout(() => {
					handlers.onReattach();
					attach();
				}, REATTACH_DELAY_MS);
			},
		});
	};
	attach();
	return () => {
		clearTimeout(retry);
		stop();
	};
};
