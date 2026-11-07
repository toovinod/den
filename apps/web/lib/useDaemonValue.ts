import { useCallback, useEffect, useState } from "react";
import { errorMessage } from "./daemonRuntime.ts";

export type Loaded<A> =
	| { readonly state: "loading" }
	| { readonly state: "ready"; readonly value: A }
	| { readonly state: "failed"; readonly message: string };

// Loads a value from the daemon whenever key changes, or when reload is called. A reload keeps showing the
// previous value until the new one arrives, so panels do not flash empty.
export const useDaemonValue = <A>(load: () => Promise<A>, key: string) => {
	const [loaded, setLoaded] = useState<Loaded<A>>({ state: "loading" });
	const [round, setRound] = useState(0);
	// biome-ignore lint/correctness/useExhaustiveDependencies: key names everything load reads.
	useEffect(() => {
		setLoaded({ state: "loading" });
	}, [key]);
	// biome-ignore lint/correctness/useExhaustiveDependencies: key and round are the reload signals.
	useEffect(() => {
		let live = true;
		load().then(
			(value) => live && setLoaded({ state: "ready", value }),
			(error: unknown) => live && setLoaded({ state: "failed", message: errorMessage(error) }),
		);
		return () => {
			live = false;
		};
	}, [key, round]);
	const reload = useCallback(() => setRound((current) => current + 1), []);
	return { loaded, reload };
};
