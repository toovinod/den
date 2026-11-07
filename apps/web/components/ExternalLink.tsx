"use client";

import { openExternal } from "../lib/desktop.ts";
import type { ComponentProps } from "react";
import { toast } from "../lib/store.ts";

// An anchor that opens in the system browser and never navigates the app's window.
export const ExternalLink = ({ href, children, ...props }: ComponentProps<"a">) => (
	<a
		{...props}
		href={href}
		target="_blank"
		rel="noreferrer"
		onClick={(event) => {
			event.preventDefault();
			if (href !== undefined) openExternal(href).catch(() => toast("Could not open the link in your browser."));
		}}
	>
		{children}
	</a>
);
