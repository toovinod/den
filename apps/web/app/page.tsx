"use client";

import { useEffect, useState } from "react";
import { fetchDaemonVersion } from "../lib/daemonRuntime";

type DaemonStatus =
	| { readonly state: "connecting" }
	| { readonly state: "connected"; readonly version: string }
	| { readonly state: "failed" };

export default function Home() {
	const [status, setStatus] = useState<DaemonStatus>({ state: "connecting" });

	useEffect(() => {
		fetchDaemonVersion().then(
			(version) => setStatus({ state: "connected", version }),
			() => setStatus({ state: "failed" }),
		);
	}, []);

	return (
		<main className="daemonStatus">
			<h1>Swarm</h1>
			{status.state === "connecting" && <p>Connecting to the daemon...</p>}
			{status.state === "connected" && <p>Daemon v{status.version} is running.</p>}
			{status.state === "failed" && <p>Could not reach the daemon. Open Swarm from the desktop app.</p>}
		</main>
	);
}
