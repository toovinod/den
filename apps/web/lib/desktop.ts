import { isPermissionGranted, requestPermission, sendNotification } from "@tauri-apps/plugin-notification";
import { openUrl } from "@tauri-apps/plugin-opener";
import { open } from "@tauri-apps/plugin-dialog";
import { isTauri } from "@tauri-apps/api/core";

// What the desktop shell adds over a browser. In a browser during development these fall back or do nothing.
export const isDesktop = () => isTauri();

export const pickFolder = async (title: string) => {
	const picked = await open({ directory: true, multiple: false, title });
	return typeof picked === "string" ? picked : null;
};

// Links go to the system browser. Navigating the app's own window would hand the page, and the IPC bridge it
// holds, to whatever site the link points at.
export const openExternal = async (url: string) => {
	if (isDesktop()) await openUrl(url);
	else window.open(url, "_blank", "noreferrer");
};

let permission: Promise<boolean> | null = null;

const canNotify = () => {
	permission ??= isPermissionGranted().then((granted) =>
		granted ? true : requestPermission().then((answer) => answer === "granted"),
	);
	return permission;
};

export const showNotification = async (title: string, body: string) => {
	if (isDesktop() && (await canNotify())) {
		sendNotification({ title, body });
	}
};

let chime: HTMLAudioElement | null = null;

export const playChime = () => {
	chime ??= new Audio("/chime.wav");
	chime.currentTime = 0;
	// Autoplay rules can refuse sound before the user has clicked anything. Silence is the right fallback.
	chime.play().catch(() => undefined);
};
