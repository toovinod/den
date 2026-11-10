"use client";

import { useLayoutEffect, useRef } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { ChatState } from "../lib/chatReducer.ts";
import { loadOlderEvents } from "../lib/store.ts";
import { ChatItemView } from "./ChatItemView.tsx";

// Within this many pixels of the end counts as reading the latest message, so new output keeps it in view.
const STICK_DISTANCE = 48;
// Older messages start loading this close to the top, so scrolling up rarely has to wait for them.
const LOAD_DISTANCE = 400;

export const ChatTimeline = ({ chat, footer }: { readonly chat: ChatState; readonly footer: React.ReactNode }) => {
	const scrollRef = useRef<HTMLDivElement>(null);
	const atEnd = useRef(true);
	// Where the reader was, measured from the end, and the first item then. When older items arrive above,
	// the same distance from the end keeps the same messages in view.
	const fromEnd = useRef(0);
	const firstKey = useRef<string | undefined>(undefined);
	const virtualizer = useVirtualizer({
		count: chat.items.length,
		getScrollElement: () => scrollRef.current,
		estimateSize: () => 56,
		getItemKey: (index) => chat.items[index]?.key ?? index,
		overscan: 6,
		gap: 14,
		paddingStart: 24,
		paddingEnd: 24,
	});

	// Runs before paint, so a growing message never shows a frame scrolled away from the end.
	useLayoutEffect(() => {
		const element = scrollRef.current;
		if (element === null) return;
		const first = chat.items[0]?.key;
		if (atEnd.current) element.scrollTop = element.scrollHeight;
		else if (first !== firstKey.current) element.scrollTop = element.scrollHeight - fromEnd.current;
		firstKey.current = first;
		fromEnd.current = element.scrollHeight - element.scrollTop;
		// A first page shorter than the view gives nothing to scroll, so the next one loads at once.
		if (element.scrollHeight <= element.clientHeight) void loadOlderEvents();
	});

	return (
		<div
			ref={scrollRef}
			className="min-h-0 flex-1 overflow-y-auto [overflow-anchor:none]"
			onScroll={(event) => {
				const element = event.currentTarget;
				atEnd.current = element.scrollHeight - element.scrollTop - element.clientHeight < STICK_DISTANCE;
				fromEnd.current = element.scrollHeight - element.scrollTop;
				if (element.scrollTop < LOAD_DISTANCE) void loadOlderEvents();
			}}
		>
			<div className="relative mx-auto w-full max-w-3xl px-6" style={{ height: virtualizer.getTotalSize() }}>
				{virtualizer.getVirtualItems().map((row) => {
					const item = chat.items[row.index];
					return item === undefined ? null : (
						<div
							key={row.key}
							data-index={row.index}
							ref={virtualizer.measureElement}
							className="absolute inset-x-6"
							style={{ transform: `translateY(${row.start}px)` }}
						>
							<ChatItemView item={item} sessionId={chat.sessionId} />
						</div>
					);
				})}
			</div>
			{footer}
		</div>
	);
};
