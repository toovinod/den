import {
	applyFontSize,
	defaultSettings,
	loadSettings,
	readStored,
	type Settings,
	saveSettings,
	writeStored,
} from "./settings.ts";
import type { AgentAuthMode, AgentInfo, AgentKind, AgentSession, ImageData } from "@repo/contracts/AgentSession";
import { callDaemon, errorMessage, errorTag, followDaemon } from "./daemonRuntime.ts";
import { applyEvents, type ChatState, emptyChat } from "./chatReducer.ts";
import type { CreateWorkspaceInput } from "@repo/contracts/WorkspaceRpcs";
import type { ApprovalDecision } from "@repo/contracts/AgentEvent";
import type { SessionEvent } from "@repo/contracts/SessionEvent";
import { playChime, showNotification } from "./desktop.ts";
import type { Workspace } from "@repo/contracts/Workspace";
import type { Project } from "@repo/contracts/Project";
import { useSyncExternalStore } from "react";
import { toast as showToast } from "sonner";
import { Redacted } from "effect";

export type PanelTab = "diff" | "files" | "terminal" | "run" | "pr";

export type DialogState =
	| { readonly kind: "palette" }
	| { readonly kind: "newProject" }
	| { readonly kind: "newWorkspace"; readonly projectId: string }
	| { readonly kind: "settings"; readonly tab: "accounts" | "appearance" | "notifications" }
	| { readonly kind: "workspaceSettings"; readonly workspaceId: string };

export type Attention = "approval" | "done" | "failed";

export interface AppState {
	readonly connection:
		| { readonly status: "connecting" | "ready" }
		| { readonly status: "failed"; readonly message: string };
	// One record per entity, keyed by id. Lists are derived where they are shown.
	readonly projects: Readonly<Record<string, Project>>;
	readonly workspaces: Readonly<Record<string, Workspace>>;
	readonly sessions: Readonly<Record<string, AgentSession>>;
	readonly agents: ReadonlyArray<AgentInfo>;
	// Chats closed as tabs. They stay in the sidebar and reopen as a tab when picked.
	readonly closedTabs: ReadonlySet<string>;
	readonly attention: Readonly<Record<string, Attention>>;
	readonly selectedWorkspaceId: string | null;
	readonly selectedSessionId: string | null;
	// Only the visible chat's events are in memory.
	readonly chat: ChatState | null;
	readonly panel: { readonly open: boolean; readonly tab: PanelTab };
	readonly dialog: DialogState | null;
	readonly settings: Settings;
}

let state: AppState = {
	connection: { status: "connecting" },
	projects: {},
	workspaces: {},
	sessions: {},
	agents: [],
	closedTabs: new Set(),
	attention: {},
	selectedWorkspaceId: null,
	selectedSessionId: null,
	chat: null,
	panel: { open: true, tab: "diff" },
	dialog: null,
	settings: defaultSettings,
};

const listeners = new Set<() => void>();

export const getState = () => state;

const setState = (update: (current: AppState) => Partial<AppState>) => {
	state = { ...state, ...update(state) };
	for (const listener of listeners) listener();
};

const subscribe = (listener: () => void) => {
	listeners.add(listener);
	return () => listeners.delete(listener);
};

// Selectors must return a value already in the state, or a primitive, so React can skip unchanged renders.
export const useAppState = <A>(select: (current: AppState) => A): A =>
	useSyncExternalStore(
		subscribe,
		() => select(state),
		() => select(state),
	);

const byId = <A extends { readonly id: string }>(items: ReadonlyArray<A>) =>
	Object.fromEntries(items.map((item) => [item.id, item]));

const without = <A>(record: Readonly<Record<string, A>>, key: string) => {
	const { [key]: _, ...rest } = record;
	return rest;
};

export const toast = (text: string, tone: "error" | "info" = "error") =>
	tone === "error" ? showToast.error(text) : showToast(text);

// Runs a daemon call and shows its error as a toast. Returns null when it failed.
const attempt = <A>(run: () => Promise<A>): Promise<A | null> =>
	run().catch((error: unknown) => {
		toast(errorMessage(error));
		return null;
	});

// Data

const LAST_WORKSPACE_KEY = "den.lastWorkspace";

// Without storage the app opens the first workspace next time, which is fine.
const rememberWorkspace = (workspaceId: string) => writeStored(LAST_WORKSPACE_KEY, workspaceId);

const loadWorkspaces = async (projectId: string) => {
	const workspaces = await callDaemon((daemon) => daemon.listWorkspaces({ projectId }));
	const active = workspaces.filter((workspace) => workspace.status === "active");
	const sessions = await Promise.all(
		active.map((workspace) => callDaemon((daemon) => daemon.listSessions({ workspaceId: workspace.id }))),
	);
	setState((current) => ({
		workspaces: { ...current.workspaces, ...byId(workspaces) },
		sessions: { ...current.sessions, ...byId(sessions.flat()) },
	}));
};

export const refreshAgents = async () => {
	const agents = await attempt(() => callDaemon((daemon) => daemon.listAgents()));
	if (agents !== null) setState(() => ({ agents }));
};

export const boot = async () => {
	const settings = loadSettings();
	applyFontSize(settings);
	setState(() => ({ settings }));
	const loaded = await callDaemon((daemon) => daemon.listProjects())
		.then(async (projects) => {
			setState(() => ({ projects: byId(projects) }));
			await Promise.all(projects.map((project) => loadWorkspaces(project.id)));
			setState(() => ({ connection: { status: "ready" } }));
			return true;
		})
		.catch((error: unknown) => {
			setState(() => ({ connection: { status: "failed", message: errorMessage(error) } }));
			return false;
		});
	if (!loaded) return;
	// Checking the agents starts their CLIs and reads the keychain, so it never holds up files, terminals or history.
	void refreshAgents();
	watchSessions();
	const remembered = readStored(LAST_WORKSPACE_KEY);
	const active = Object.values(state.workspaces).filter((workspace) => workspace.status === "active");
	const start = active.find((workspace) => workspace.id === remembered) ?? active[0];
	if (start !== undefined) selectWorkspace(start.id);
};

// Session changes from every workspace. They drive status dots, tab badges and notifications.
const watchSessions = () => {
	followDaemon((daemon) => daemon.watchSessions(), {
		onItem: (session) => {
			const before = state.sessions[session.id];
			setState((current) => ({ sessions: { ...current.sessions, [session.id]: session } }));
			if (before !== undefined) noticeChange(before, session);
		},
		// The socket dropped. Watch again, then reload the lists the stream was keeping fresh. While the daemon
		// is still away the reload fails with a toast, and the next drop of the new watch tries again.
		onEnd: () => {
			setTimeout(() => {
				watchSessions();
				for (const project of Object.values(state.projects)) {
					loadWorkspaces(project.id).catch(() => toast("Lost the connection to the daemon. Reconnecting."));
				}
			}, 1000);
		},
	});
};

const noticeChange = (before: AgentSession, after: AgentSession) => {
	const attention: Attention | null =
		after.status === "awaitingApproval" && before.status !== "awaitingApproval"
			? "approval"
			: before.status === "running" && after.status === "idle"
				? "done"
				: after.status === "failed" && before.status !== "failed"
					? "failed"
					: null;
	if (attention === null) return;
	const visible = state.selectedSessionId === after.id && document.visibilityState === "visible";
	if (!visible) setState((current) => ({ attention: { ...current.attention, [after.id]: attention } }));
	if (document.hasFocus()) return;
	lastNotified = after.id;
	const { settings } = state;
	const title = sessionTitle(after);
	const body =
		attention === "approval"
			? "The agent needs your approval."
			: attention === "done"
				? "The turn finished."
				: "The turn failed.";
	if (settings.desktopNotifications) void showNotification(title, body);
	if (settings.sound) playChime();
};

// The desktop notification cannot report a click, so the chat that notified last opens when the window comes back.
let lastNotified: string | null = null;

export const onWindowFocus = () => {
	const sessionId = lastNotified;
	lastNotified = null;
	if (sessionId !== null && state.sessions[sessionId] !== undefined) selectSession(sessionId);
};

export const sessionTitle = (session: AgentSession) =>
	session.title ?? `${session.agent === "claude" ? "Claude" : "Codex"} chat`;

// Projects

export const addProject = async (path: string) => {
	const project = await callDaemon((daemon) => daemon.addProject({ path }));
	setState((current) => ({ projects: { ...current.projects, [project.id]: project } }));
	return project;
};

export const createProject = async (parentPath: string, name: string) => {
	const project = await callDaemon((daemon) => daemon.createProject({ parentPath, name }));
	setState((current) => ({ projects: { ...current.projects, [project.id]: project } }));
	return project;
};

export const removeProject = async (projectId: string) => {
	const done = await attempt(() => callDaemon((daemon) => daemon.removeProject({ projectId })));
	if (done === null) return;
	setState((current) => ({
		projects: without(current.projects, projectId),
		workspaces: Object.fromEntries(
			Object.entries(current.workspaces).filter(([, workspace]) => workspace.projectId !== projectId),
		),
	}));
};

export const setProjectTrust = async (projectId: string, trusted: boolean) => {
	const before = state.projects[projectId];
	if (before === undefined) return;
	// Optimistic: the switch moves at once and moves back if the daemon refuses.
	setState((current) => ({ projects: { ...current.projects, [projectId]: { ...before, trusted } } }));
	const saved = await attempt(() => callDaemon((daemon) => daemon.setProjectTrust({ projectId, trusted })));
	setState((current) => ({ projects: { ...current.projects, [projectId]: saved ?? before } }));
};

export const updateProjectScripts = async (projectId: string, setupScript: string | null, runScript: string | null) => {
	const saved = await callDaemon((daemon) => daemon.updateProjectScripts({ projectId, setupScript, runScript }));
	setState((current) => ({ projects: { ...current.projects, [projectId]: saved } }));
	return saved;
};

// Workspaces

export const createWorkspace = async (input: CreateWorkspaceInput) => {
	const workspace = await callDaemon((daemon) => daemon.createWorkspace(input));
	setState((current) => ({ workspaces: { ...current.workspaces, [workspace.id]: workspace } }));
	selectWorkspace(workspace.id);
	return workspace;
};

// Fails with the daemon's error, so the caller can offer to force past unsaved work.
export const archiveWorkspace = async (workspaceId: string, force: boolean) => {
	const archived = await callDaemon((daemon) => daemon.archiveWorkspace({ workspaceId, force }));
	setState((current) => ({
		workspaces: { ...current.workspaces, [workspaceId]: archived },
		...(current.selectedWorkspaceId === workspaceId ? { selectedWorkspaceId: null, selectedSessionId: null } : {}),
	}));
	if (state.selectedSessionId === null) closeChat();
};

export const isUnsavedWorkError = (error: unknown) => errorTag(error) === "WorkspaceHasUnsavedWorkError";

export const updateWorkspace = (workspace: Workspace) =>
	setState((current) => ({ workspaces: { ...current.workspaces, [workspace.id]: workspace } }));

export const workspaceTabs = (
	sessions: AppState["sessions"],
	closedTabs: AppState["closedTabs"],
	workspaceId: string,
) =>
	Object.values(sessions)
		.filter((session) => session.workspaceId === workspaceId && !closedTabs.has(session.id))
		.sort((a, b) => a.createdAt.localeCompare(b.createdAt));

export const selectWorkspace = (workspaceId: string) => {
	rememberWorkspace(workspaceId);
	const first = workspaceTabs(state.sessions, state.closedTabs, workspaceId)[0];
	setState(() => ({ selectedWorkspaceId: workspaceId }));
	if (first === undefined) {
		setState(() => ({ selectedSessionId: null }));
		closeChat();
	} else {
		selectSession(first.id);
	}
};

// Sessions

export const selectSession = (sessionId: string) => {
	const session = state.sessions[sessionId];
	if (session === undefined) return;
	setState((current) => {
		const closedTabs = new Set(current.closedTabs);
		closedTabs.delete(sessionId);
		return {
			selectedWorkspaceId: session.workspaceId,
			selectedSessionId: sessionId,
			closedTabs,
			attention: without(current.attention, sessionId),
		};
	});
	rememberWorkspace(session.workspaceId);
	if (state.chat?.sessionId !== sessionId) openChat(sessionId);
};

const defaultChoice = () => {
	const { agents, settings } = state;
	const agent =
		agents.find((info) => info.kind === settings.lastAgent) ??
		agents.find((info) => info.availability.status === "ready") ??
		agents[0];
	if (agent === undefined) return null;
	const model =
		agent.models.find((item) => item.id === settings.lastModel) ??
		agent.models.find((item) => item.id === agent.defaultModel);
	return model === undefined ? null : { agent, model };
};

// Returns the new chat's session id, or null after telling the user why none was created.
export const newChat = async (
	workspaceId = state.selectedWorkspaceId,
	agentKind?: AgentKind,
): Promise<string | null> => {
	if (workspaceId === null) {
		toast("Pick a workspace first.", "info");
		return null;
	}
	const choice = defaultChoice();
	const agent = agentKind === undefined ? choice?.agent : state.agents.find((info) => info.kind === agentKind);
	const model =
		agent === undefined
			? undefined
			: agent.kind === choice?.agent.kind
				? choice.model
				: agent.models.find((item) => item.id === agent.defaultModel);
	if (agent === undefined || model === undefined) {
		toast("No agent is available. Check Settings.", "info");
		return null;
	}
	const session = await attempt(() =>
		callDaemon((daemon) =>
			daemon.createSession({ workspaceId, agent: agent.kind, model: model.id, effort: model.defaultEffort }),
		),
	);
	if (session === null) return null;
	setState((current) => ({ sessions: { ...current.sessions, [session.id]: session } }));
	selectSession(session.id);
	return session.id;
};

export const renameSession = async (sessionId: string, title: string) => {
	const before = state.sessions[sessionId];
	if (before === undefined) return;
	setState((current) => ({
		sessions: { ...current.sessions, [sessionId]: { ...before, title: title.trim() || null } },
	}));
	const saved = await attempt(() => callDaemon((daemon) => daemon.renameSession({ sessionId, title })));
	setState((current) => ({ sessions: { ...current.sessions, [sessionId]: saved ?? before } }));
};

export const updateSessionSettings = async (sessionId: string, model: string, effort: string | null) => {
	const before = state.sessions[sessionId];
	if (before === undefined) return;
	setState((current) => ({
		sessions: { ...current.sessions, [sessionId]: { ...before, model, effort } },
		settings: { ...current.settings, lastAgent: before.agent, lastModel: model },
	}));
	saveSettings(state.settings);
	const saved = await attempt(() => callDaemon((daemon) => daemon.updateSessionSettings({ sessionId, model, effort })));
	setState((current) => ({ sessions: { ...current.sessions, [sessionId]: saved ?? before } }));
};

// Closing a tab only hides the chat. A running agent keeps working in the background, its chat stays in the
// sidebar, and it notifies when it finishes or needs approval. The composer's stop button is what interrupts it.
export const closeTab = (sessionId: string) => {
	const session = state.sessions[sessionId];
	if (session === undefined) return;
	const remaining = workspaceTabs(state.sessions, state.closedTabs, session.workspaceId).filter(
		(tab) => tab.id !== sessionId,
	);
	setState((current) => ({ closedTabs: new Set([...current.closedTabs, sessionId]) }));
	if (state.selectedSessionId !== sessionId) return;
	const next = remaining.at(-1);
	if (next === undefined) {
		setState(() => ({ selectedSessionId: null }));
		closeChat();
	} else {
		selectSession(next.id);
	}
};

export const sendMessage = (sessionId: string, text: string, images: ReadonlyArray<ImageData>, steer: boolean) =>
	callDaemon((daemon) => daemon.sendMessage({ sessionId, text, images: [...images], steer }));

export const interruptSession = (sessionId: string) =>
	attempt(() => callDaemon((daemon) => daemon.interruptSession({ sessionId })));

export const respondToApproval = (sessionId: string, requestId: string, decision: ApprovalDecision) =>
	attempt(() => callDaemon((daemon) => daemon.respondToApproval({ sessionId, requestId, decision })));

// The visible chat

let stopChat: (() => void) | null = null;
let pending: Array<SessionEvent> = [];
let flushScheduled = false;
// Bumped each time a chat stream starts or stops. Interrupting a stream is asynchronous, so a stopped stream can
// still deliver events or end with an error. Checking its generation drops those instead of mixing them into the
// next chat or resubscribing a chat that was closed.
let chatGeneration = 0;

// Deltas can arrive hundreds of times a second. Applying them once per frame keeps typing and scrolling smooth.
const flush = () => {
	flushScheduled = false;
	const events = pending;
	pending = [];
	setState((current) =>
		current.chat === null || events.length === 0 ? {} : { chat: applyEvents(current.chat, events) },
	);
};

const follow = (sessionId: string, afterSequence: number) => {
	stopChat?.();
	const generation = ++chatGeneration;
	const isCurrent = () => generation === chatGeneration;
	const stop = followDaemon((daemon) => daemon.subscribeSession({ sessionId, afterSequence }), {
		onItem: (event) => {
			if (!isCurrent()) return;
			pending.push(event);
			if (!flushScheduled) {
				flushScheduled = true;
				requestAnimationFrame(flush);
			}
		},
		onEnd: (error) => {
			if (!isCurrent()) return;
			flush();
			const resume = () => {
				if (isCurrent() && state.chat?.sessionId === sessionId) follow(sessionId, state.chat.lastSequence);
			};
			// Too far behind, or the socket dropped: pick up after the last event we hold, without clearing the chat.
			if (errorTag(error) === "ResubscribeRequiredError") resume();
			else if (error !== null && errorTag(error) !== "SessionNotFoundError") setTimeout(resume, 1000);
		},
	});
	stopChat = () => {
		if (isCurrent()) chatGeneration++;
		stop();
	};
};

const openChat = (sessionId: string) => {
	closeChat();
	setState(() => ({ chat: emptyChat(sessionId) }));
	follow(sessionId, -1);
};

const closeChat = () => {
	stopChat?.();
	stopChat = null;
	pending = [];
	if (state.chat !== null) setState(() => ({ chat: null }));
};

// Layout and dialogs

export const openDialog = (dialog: DialogState | null) => setState(() => ({ dialog }));

export const setPanel = (panel: Partial<AppState["panel"]>) =>
	setState((current) => ({ panel: { ...current.panel, ...panel } }));

export const updateSettings = (changes: Partial<Settings>) => {
	setState((current) => ({ settings: { ...current.settings, ...changes } }));
	saveSettings(state.settings);
	applyFontSize(state.settings);
};

// Accounts

export const setAgentApiKey = async (agent: AgentKind, apiKey: string) => {
	const saved = await attempt(() =>
		callDaemon((daemon) => daemon.setAgentApiKey({ agent, apiKey: Redacted.make(apiKey) })),
	);
	await refreshAgents();
	return saved !== null;
};

export const removeAgentApiKey = async (agent: AgentKind) => {
	await attempt(() => callDaemon((daemon) => daemon.removeAgentApiKey({ agent })));
	await refreshAgents();
};

export const setAgentAuthMode = async (agent: AgentKind, mode: AgentAuthMode) => {
	await attempt(() => callDaemon((daemon) => daemon.setAgentAuthMode({ agent, mode })));
	await refreshAgents();
};

export const startAgentLogin = (agent: AgentKind) =>
	attempt(() => callDaemon((daemon) => daemon.startAgentLogin({ agent })));
