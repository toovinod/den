import { Effect, Schema } from "effect";

// Preferences that belong to this window only, kept in localStorage.
export const Settings = Schema.Struct({
	fontSize: Schema.Literals(["small", "default", "large"]),
	desktopNotifications: Schema.Boolean,
	sound: Schema.Boolean,
	diffMode: Schema.Literals(["unified", "split"]),
	// The agent and model a new chat starts with, after the user picked them once.
	lastAgent: Schema.NullOr(Schema.Literals(["claude", "codex"])),
	lastModel: Schema.NullOr(Schema.String),
});
export type Settings = typeof Settings.Type;

export const defaultSettings: Settings = {
	fontSize: "default",
	desktopNotifications: true,
	sound: true,
	diffMode: "unified",
	lastAgent: null,
	lastModel: null,
};

const KEY = "den.settings";

// Storage can be missing or blocked (private windows, prerendering). Reads then find nothing and writes do nothing.
export const readStored = (key: string): string | null =>
	Effect.try(() => localStorage.getItem(key)).pipe(
		Effect.orElseSucceed(() => null),
		Effect.runSync,
	);

export const writeStored = (key: string, value: string) =>
	Effect.try(() => localStorage.setItem(key, value)).pipe(Effect.ignore, Effect.runSync);
const StoredSettings = Schema.fromJsonString(Settings);

// An older version may have saved another shape. The defaults then fill in what does not fit.
export const loadSettings = (): Settings =>
	Effect.fromNullishOr(readStored(KEY)).pipe(
		Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)))),
		Effect.map((saved) => {
			const merged = { ...defaultSettings, ...saved };
			return Schema.is(Settings)(merged) ? merged : defaultSettings;
		}),
		Effect.orElseSucceed(() => defaultSettings),
		Effect.runSync,
	);

export const saveSettings = (settings: Settings) => writeStored(KEY, Schema.encodeSync(StoredSettings)(settings));

// The root size scales every rem in the UI, so one setting resizes the whole window.
const ROOT_FONT_SIZES = { small: "14px", default: "15px", large: "16px" } as const;

export const applyFontSize = (settings: Settings) => {
	document.documentElement.style.fontSize = ROOT_FONT_SIZES[settings.fontSize];
};
