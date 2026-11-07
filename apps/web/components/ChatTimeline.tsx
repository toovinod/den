"use client";

import { useLayoutEffect, useRef } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { ChatState } from "../lib/chatReducer.ts";
import { ChatItemView } from "./ChatItemView.tsx";

// Within this many pixels of the end counts as reading the latest message, so new output keeps it in view.
const STICK_DISTANCE = 48;

export const ChatTimeline = ({ chat, footer }: { readonly chat: ChatState; readonly footer: React.ReactNode }) => {
	const scrollRef = useRef<HTMLDivElement>(null);
	const atEnd = useRef(true);
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
		if (element !== null && atEnd.current) element.scrollTop = element.scrollHeight;
	});

	return (
		<div
			ref={scrollRef}
			className="min-h-0 flex-1 overflow-y-auto [overflow-anchor:none]"
			onScroll={(event) => {
				const element = event.currentTarget;
				atEnd.current = element.scrollHeight - element.scrollTop - element.clientHeight < STICK_DISTANCE;
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
