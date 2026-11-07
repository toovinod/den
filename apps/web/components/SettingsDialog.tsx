"use client";

import {
	openDialog,
	refreshAgents,
	removeAgentApiKey,
	setAgentApiKey,
	setAgentAuthMode,
	startAgentLogin,
	toast,
	updateSettings,
	useAppState,
} from "../lib/store.ts";
import type { AgentAvailability, AgentInfo } from "@repo/contracts/AgentSession";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@repo/ui/components/tabs";
import type { Settings } from "../lib/settings.ts";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@repo/ui/components/dialog";
import { openExternal, playChime } from "../lib/desktop.ts";
import { Switch } from "@repo/ui/components/switch";
import { Button } from "@repo/ui/components/button";
import { Input } from "@repo/ui/components/input";
import { Label } from "@repo/ui/components/label";
import { useTheme } from "next-themes";
import { useState } from "react";
import { cn } from "@repo/ui/lib/utils";

const SETTINGS_TABS = ["accounts", "appearance", "notifications"] as const;
type SettingsTab = (typeof SETTINGS_TABS)[number];
const isSettingsTab = (value: string): value is SettingsTab => SETTINGS_TABS.some((tab) => tab === value);

export const SettingsDialog = () => {
	const dialog = useAppState((current) => current.dialog);
	const open = dialog?.kind === "settings";
	return (
		<Dialog open={open} onOpenChange={(next) => !next && openDialog(null)}>
			{dialog?.kind === "settings" ? (
				<DialogContent className="flex h-[32rem] flex-col sm:max-w-xl">
					<DialogHeader>
						<DialogTitle>Settings</DialogTitle>
					</DialogHeader>
					<Tabs
						value={dialog.tab}
						onValueChange={(tab) => {
							if (isSettingsTab(tab)) openDialog({ kind: "settings", tab });
						}}
						className="min-h-0 flex-1 gap-3"
					>
						<TabsList>
							<TabsTrigger value="accounts">Accounts</TabsTrigger>
							<TabsTrigger value="appearance">Appearance</TabsTrigger>
							<TabsTrigger value="notifications">Notifications</TabsTrigger>
						</TabsList>
						<TabsContent value="accounts" className="overflow-y-auto">
							<Accounts />
						</TabsContent>
						<TabsContent value="appearance">
							<Appearance />
						</TabsContent>
						<TabsContent value="notifications">
							<Notifications />
						</TabsContent>
					</Tabs>
				</DialogContent>
			) : null}
		</Dialog>
	);
};

const Accounts = () => {
	const agents = useAppState((current) => current.agents);
	return (
		<div className="flex flex-col gap-3">
			{agents.length === 0 ? (
				<div className="flex items-center gap-2 text-xs text-muted-foreground">
					Checking your agents.
					<Button variant="secondary" size="sm" onClick={() => void refreshAgents()}>
						Retry
					</Button>
				</div>
			) : (
				agents.map((agent) => <AgentAccount key={agent.kind} agent={agent} />)
			)}
		</div>
	);
};

const availabilityText = (availability: AgentAvailability) => {
	switch (availability.status) {
		case "ready":
			return availability.account === null ? "Ready" : `Signed in as ${availability.account}`;
		case "needsApiKey":
			return "Needs an API key";
		case "loggedOut":
			return "Not signed in";
		case "notInstalled":
			return "Not installed on this computer";
		case "versionMismatch":
			return `Version ${availability.actual} is installed, Den needs ${availability.expected}`;
		case "unknown":
			return availability.message;
	}
};

const AgentAccount = ({ agent }: { readonly agent: AgentInfo }) => {
	const [apiKey, setApiKey] = useState("");
	const [login, setLogin] = useState<string | null>(null);
	const name = agent.kind === "claude" ? "Claude Code" : "Codex";
	const ready = agent.availability.status === "ready";
	return (
		<section className="flex flex-col gap-2.5 rounded-md border p-3">
			<div className="flex items-center gap-2">
				<span className="font-medium">{name}</span>
				<span className={cn("text-xs", ready ? "text-success" : "text-attention")}>
					{availabilityText(agent.availability)}
				</span>
				{agent.availability.status === "unknown" ? (
					<Button variant="ghost" size="sm" className="ml-auto" onClick={() => void refreshAgents()}>
						Check again
					</Button>
				) : null}
			</div>
			{agent.kind === "claude" ? (
				<p className="text-xs text-muted-foreground">
					Anthropic does not yet allow Claude subscriptions in other apps, so Den runs Claude Code with your Anthropic
					API key. The key stays in the system keychain.
				</p>
			) : null}
			{agent.authModes.length > 1 ? (
				<Tabs
					value={agent.authMode}
					onValueChange={(value) => {
						const mode = agent.authModes.find((item) => item === value);
						if (mode !== undefined) void setAgentAuthMode(agent.kind, mode);
					}}
				>
					<TabsList aria-label={`${name} sign-in`} className="w-full">
						{agent.authModes.map((mode) => (
							<TabsTrigger key={mode} value={mode} className="text-xs">
								{mode === "subscription" ? (agent.kind === "codex" ? "ChatGPT account" : "Subscription") : "API key"}
							</TabsTrigger>
						))}
					</TabsList>
				</Tabs>
			) : null}
			{agent.authMode === "subscription" && agent.kind === "codex" ? (
				<div className="flex flex-col gap-1.5">
					<Button
						variant="secondary"
						size="sm"
						className="self-start"
						onClick={async () => {
							const started = await startAgentLogin(agent.kind);
							if (started === null) return;
							setLogin(started.authUrl);
							openExternal(started.authUrl).catch(() =>
								toast("Could not open the sign-in page. Open the link below instead."),
							);
						}}
					>
						Sign in with ChatGPT
					</Button>
					{login === null ? null : (
						<p className="text-xs break-all text-muted-foreground">
							Finish signing in on the page that opened. If none did, open <span className="font-mono">{login}</span>
						</p>
					)}
				</div>
			) : (
				<form
					className="flex gap-1.5"
					onSubmit={async (event) => {
						event.preventDefault();
						if (await setAgentApiKey(agent.kind, apiKey.trim())) setApiKey("");
					}}
				>
					<Input
						type="password"
						autoComplete="off"
						value={apiKey}
						onChange={(event) => setApiKey(event.target.value)}
						placeholder={agent.kind === "claude" ? "sk-ant-..." : "sk-..."}
						aria-label={`${name} API key`}
						className="h-8 font-mono"
					/>
					<Button variant="secondary" size="sm" type="submit" disabled={apiKey.trim() === ""}>
						Save key
					</Button>
					{ready ? (
						<Button variant="ghost" size="sm" onClick={() => void removeAgentApiKey(agent.kind)}>
							Remove
						</Button>
					) : null}
				</form>
			)}
		</section>
	);
};

const Choice = <A extends string>({
	label,
	options,
	value,
	onChange,
}: {
	readonly label: string;
	readonly options: ReadonlyArray<readonly [A, string]>;
	readonly value: A;
	readonly onChange: (value: A) => void;
}) => (
	<div className="flex items-center justify-between gap-4">
		<span className="text-sm">{label}</span>
		<Tabs
			value={value}
			onValueChange={(next) => {
				const option = options.find(([item]) => item === next);
				if (option !== undefined) onChange(option[0]);
			}}
		>
			<TabsList aria-label={label}>
				{options.map(([option, text]) => (
					<TabsTrigger key={option} value={option} className="px-2.5 text-xs">
						{text}
					</TabsTrigger>
				))}
			</TabsList>
		</Tabs>
	</div>
);

const Appearance = () => {
	const settings = useAppState((current) => current.settings);
	const { theme = "dark", setTheme } = useTheme();
	return (
		<div className="flex flex-col gap-4">
			<Choice
				label="Theme"
				value={theme}
				onChange={setTheme}
				options={[
					["system", "System"],
					["light", "Light"],
					["dark", "Dark"],
				]}
			/>
			<Choice<Settings["fontSize"]>
				label="Text size"
				value={settings.fontSize}
				onChange={(fontSize) => updateSettings({ fontSize })}
				options={[
					["small", "Small"],
					["default", "Default"],
					["large", "Large"],
				]}
			/>
		</div>
	);
};

const Notifications = () => {
	const settings = useAppState((current) => current.settings);
	return (
		<div className="flex flex-col gap-4">
			<p className="text-xs text-muted-foreground">
				When Den is in the background and a turn finishes or an agent needs approval.
			</p>
			<div className="flex items-center justify-between gap-4">
				<Label htmlFor="notify-desktop" className="text-sm text-foreground">
					Show a desktop notification
				</Label>
				<Switch
					id="notify-desktop"
					checked={settings.desktopNotifications}
					onCheckedChange={(desktopNotifications) => updateSettings({ desktopNotifications })}
				/>
			</div>
			<div className="flex items-center justify-between gap-4">
				<Label htmlFor="notify-sound" className="text-sm text-foreground">
					Play a sound
				</Label>
				<div className="flex items-center gap-2">
					<Button size="sm" variant="ghost" onClick={playChime}>
						Play
					</Button>
					<Switch id="notify-sound" checked={settings.sound} onCheckedChange={(sound) => updateSettings({ sound })} />
				</div>
			</div>
		</div>
	);
};
