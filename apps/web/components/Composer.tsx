"use client";

import { ArrowUpIcon, ChevronDownIcon, PlusIcon, SquareIcon, XIcon } from "lucide-react";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuLabel,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
	DropdownMenuTrigger,
} from "@repo/ui/components/dropdown-menu";
import { Textarea } from "@repo/ui/components/textarea";
import { interruptSession, sendMessage, toast, updateSessionSettings } from "../lib/store.ts";
import { type DraftImage, MAX_IMAGES_PER_MESSAGE, readImages } from "../lib/images.ts";
import { useEffect, useRef, useState, useTransition } from "react";
import type { AgentInfo, AgentSession } from "@repo/contracts/AgentSession";
import type { ChatState } from "../lib/chatReducer.ts";
import { errorMessage } from "../lib/daemonRuntime.ts";
import { formatClockTime, formatTokens } from "../lib/format.ts";
import { Hint } from "./Hint.tsx";
import { Button } from "@repo/ui/components/button";
import { cn } from "@repo/ui/lib/utils";

interface Draft {
	readonly text: string;
	readonly images: ReadonlyArray<DraftImage>;
}

// Drafts outlive the composer, so switching chats and back keeps what was typed.
const drafts = new Map<string, Draft>();

export const Composer = ({
	session,
	agent,
	chat,
}: {
	readonly session: AgentSession;
	readonly agent: AgentInfo | undefined;
	readonly chat: ChatState;
}) => {
	const [draft, setDraft] = useState<Draft>(() => drafts.get(session.id) ?? { text: "", images: [] });
	const [dragging, setDragging] = useState(false);
	const [, startTransition] = useTransition();
	const textRef = useRef<HTMLTextAreaElement>(null);
	const fileRef = useRef<HTMLInputElement>(null);
	const model = agent?.models.find((item) => item.id === session.model);
	const busy = session.status === "running" || session.status === "awaitingApproval";
	const steer = busy && agent?.capabilities.steerWhileRunning === true;

	useEffect(() => {
		drafts.set(session.id, draft);
	}, [session.id, draft]);

	useEffect(() => {
		textRef.current?.focus();
	}, []);

	const addFiles = async (files: ReadonlyArray<File>) => {
		if (files.length === 0) return;
		if (model?.supportsImages !== true) {
			toast(`${model?.label ?? "This model"} cannot read images. Pick another model to attach them.`, "info");
			return;
		}
		const { images, problems } = await readImages(files, MAX_IMAGES_PER_MESSAGE - draft.images.length);
		for (const problem of problems) toast(problem, "info");
		setDraft((current) => ({ ...current, images: [...current.images, ...images] }));
	};

	const removeImage = (id: string) =>
		setDraft((current) => {
			const image = current.images.find((item) => item.id === id);
			if (image !== undefined) URL.revokeObjectURL(image.previewUrl);
			return { ...current, images: current.images.filter((item) => item.id !== id) };
		});

	const send = () => {
		const text = draft.text.trim();
		if (text === "" && draft.images.length === 0) return;
		const sent = draft;
		setDraft({ text: "", images: [] });
		const images = sent.images.map(({ mediaType, base64 }) => ({ mediaType, base64 }));
		sendMessage(session.id, text, images, steer).then(
			() => {
				for (const image of sent.images) URL.revokeObjectURL(image.previewUrl);
			},
			(error: unknown) => {
				// Put the message back so nothing typed is lost.
				setDraft((current) => (current.text === "" ? sent : current));
				toast(errorMessage(error));
			},
		);
	};

	return (
		<div className="mx-auto w-full max-w-3xl px-6 pb-4">
			{/* biome-ignore lint/a11y/noStaticElementInteractions: dropping images is an extra way in, the + button is the accessible one. */}
			<div
				className={cn(
					"flex flex-col rounded-xl border border-border bg-card transition-colors focus-within:border-input",
					dragging && "border-running",
				)}
				onDragOver={(event) => {
					if (!event.dataTransfer.types.includes("Files")) return;
					event.preventDefault();
					setDragging(true);
				}}
				onDragLeave={() => setDragging(false)}
				onDrop={(event) => {
					event.preventDefault();
					setDragging(false);
					void addFiles([...event.dataTransfer.files]);
				}}
			>
				{draft.images.length === 0 ? null : (
					<div className="flex flex-wrap gap-2 px-3 pt-3">
						{draft.images.map((image) => (
							<div key={image.id} className="group relative">
								<img src={image.previewUrl} alt="" className="size-14 rounded-md border border-border object-cover" />
								<Button
									size="icon-xs"
									aria-label="Remove image"
									onClick={() => removeImage(image.id)}
									className="absolute -top-1.5 -right-1.5 size-4 rounded-full opacity-0 group-hover:opacity-100 focus-visible:opacity-100 [&_svg:not([class*='size-'])]:size-2.5"
								>
									<XIcon />
								</Button>
							</div>
						))}
					</div>
				)}
				<Textarea
					ref={textRef}
					rows={1}
					value={draft.text}
					placeholder={
						busy ? (steer ? "Steer the agent" : "Queue a message for when the turn ends") : "Ask for a change"
					}
					onChange={(event) => {
						const text = event.target.value;
						startTransition(() => setDraft((current) => ({ ...current, text })));
					}}
					onPaste={(event) => {
						const files = [...event.clipboardData.files].filter((file) => file.type.startsWith("image/"));
						if (files.length > 0) {
							event.preventDefault();
							void addFiles(files);
						}
					}}
					onKeyDown={(event) => {
						if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
							event.preventDefault();
							send();
						}
					}}
					className="max-h-60 min-h-11 resize-none rounded-none border-0 bg-transparent px-3.5 pt-3 pb-1 shadow-none placeholder:text-muted-foreground/60 focus-visible:ring-0 md:text-sm dark:bg-transparent"
				/>
				<div className="flex items-center gap-1 px-2 pb-2">
					<Hint label={model?.supportsImages === false ? "This model cannot read images" : "Attach images"}>
						<Button
							variant="ghost"
							size="icon-sm"
							aria-label="Attach images"
							disabled={model?.supportsImages === false}
							onClick={() => fileRef.current?.click()}
						>
							<PlusIcon />
						</Button>
					</Hint>
					<input
						ref={fileRef}
						type="file"
						accept="image/png,image/jpeg,image/gif,image/webp"
						multiple
						hidden
						onChange={(event) => {
							void addFiles([...(event.target.files ?? [])]);
							event.target.value = "";
						}}
					/>
					<ModelPicker session={session} agent={agent} />
					<div className="flex-1" />
					<RateLimit chat={chat} />
					<ContextRing chat={chat} />
					{busy ? (
						<Hint label="Stop the agent">
							<Button
								variant="secondary"
								size="icon-sm"
								aria-label="Stop"
								onClick={() => void interruptSession(session.id)}
							>
								<SquareIcon className="size-3 fill-current" />
							</Button>
						</Hint>
					) : null}
					<Hint label={busy ? (steer ? "Steer" : "Queue") : "Send"}>
						<Button
							variant="default"
							size="icon-sm"
							aria-label={busy ? (steer ? "Steer" : "Queue") : "Send"}
							disabled={draft.text.trim() === "" && draft.images.length === 0}
							onClick={send}
						>
							<ArrowUpIcon />
						</Button>
					</Hint>
				</div>
			</div>
		</div>
	);
};

const ModelPicker = ({ session, agent }: { readonly session: AgentSession; readonly agent: AgentInfo | undefined }) => {
	const model = agent?.models.find((item) => item.id === session.model);
	return (
		<>
			<DropdownMenu>
				<DropdownMenuTrigger asChild>
					<Button variant="ghost" size="xs" className="text-muted-foreground">
						{model?.label ?? session.model}
						<ChevronDownIcon />
					</Button>
				</DropdownMenuTrigger>
				<DropdownMenuContent align="start" className="w-64">
					<DropdownMenuLabel className="text-xs text-muted-foreground">
						{agent?.kind === "codex" ? "Codex" : "Claude"} model, from the next turn
					</DropdownMenuLabel>
					<DropdownMenuRadioGroup
						value={session.model}
						onValueChange={(id) => {
							const next = agent?.models.find((item) => item.id === id);
							if (next !== undefined) void updateSessionSettings(session.id, next.id, next.defaultEffort);
						}}
					>
						{agent?.models.map((item) => (
							<DropdownMenuRadioItem key={item.id} value={item.id}>
								<div className="flex flex-col">
									<span>{item.label}</span>
									<span className="text-xs text-muted-foreground">{item.description}</span>
								</div>
							</DropdownMenuRadioItem>
						))}
					</DropdownMenuRadioGroup>
				</DropdownMenuContent>
			</DropdownMenu>
			{model === undefined || model.efforts.length === 0 ? null : (
				<DropdownMenu>
					<DropdownMenuTrigger asChild>
						<Button variant="ghost" size="xs" className="text-muted-foreground capitalize">
							{session.effort ?? model.defaultEffort ?? "Effort"}
							<ChevronDownIcon />
						</Button>
					</DropdownMenuTrigger>
					<DropdownMenuContent align="start">
						<DropdownMenuLabel className="text-xs text-muted-foreground">Reasoning effort</DropdownMenuLabel>
						<DropdownMenuRadioGroup
							value={session.effort ?? model.defaultEffort ?? ""}
							onValueChange={(effort) => {
								const picked = model.efforts.find((item) => item === effort);
								if (picked !== undefined) void updateSessionSettings(session.id, model.id, picked);
							}}
						>
							{model.efforts.map((effort) => (
								<DropdownMenuRadioItem key={effort} value={effort} className="capitalize">
									{effort}
								</DropdownMenuRadioItem>
							))}
						</DropdownMenuRadioGroup>
					</DropdownMenuContent>
				</DropdownMenu>
			)}
		</>
	);
};

const RING_RADIUS = 6;
const RING_LENGTH = 2 * Math.PI * RING_RADIUS;

const ContextRing = ({ chat }: { readonly chat: ChatState }) => {
	const usage = chat.usage;
	if (usage === null || usage.contextWindow === null) return null;
	const used = Math.min(1, usage.contextTokens / usage.contextWindow);
	return (
		<Hint label={`${formatTokens(usage.contextTokens)} of ${formatTokens(usage.contextWindow)} context tokens used`}>
			<span
				className="grid size-7 place-items-center"
				role="img"
				aria-label={`${Math.round(used * 100)}% of context used`}
			>
				<svg viewBox="0 0 16 16" aria-hidden className="size-4 -rotate-90">
					<circle cx="8" cy="8" r={RING_RADIUS} fill="none" className="stroke-input" strokeWidth="2" />
					<circle
						cx="8"
						cy="8"
						r={RING_RADIUS}
						fill="none"
						className={used > 0.85 ? "stroke-attention" : "stroke-muted-foreground"}
						strokeWidth="2"
						strokeDasharray={RING_LENGTH}
						strokeDashoffset={RING_LENGTH * (1 - used)}
						strokeLinecap="round"
					/>
				</svg>
			</span>
		</Hint>
	);
};

// Shown once half of the plan window is used, or as soon as the provider warns.
const RateLimit = ({ chat }: { readonly chat: ChatState }) => {
	const limit = chat.rateLimit;
	if (limit === null || (limit.status === "allowed" && (limit.usedPercent ?? 0) < 50)) return null;
	const used =
		limit.usedPercent === null
			? "Plan limit reached"
			: `${Math.round(limit.usedPercent)}% of ${limit.window} limit used`;
	const resets = limit.resetsAt === null ? null : formatClockTime(limit.resetsAt);
	return (
		<span className={cn("px-1 text-xs", limit.status === "allowed" ? "text-muted-foreground" : "text-attention")}>
			{resets === null ? used : `${used}, resets ${resets}`}
		</span>
	);
};
