import { Tooltip, TooltipContent, TooltipTrigger } from "@repo/ui/components/tooltip";

// A short tooltip for an icon button, which has no visible label of its own.
export const Hint = ({
	label,
	side,
	children,
}: {
	readonly label: string;
	readonly side?: "top" | "right" | "bottom" | "left";
	readonly children: React.ReactNode;
}) => (
	<Tooltip>
		<TooltipTrigger asChild>{children}</TooltipTrigger>
		<TooltipContent side={side}>{label}</TooltipContent>
	</Tooltip>
);
