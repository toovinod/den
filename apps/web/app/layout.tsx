import { ThemeProvider } from "next-themes";
import localFont from "next/font/local";
import type { Metadata } from "next";
import "@xterm/xterm/css/xterm.css";
import "@repo/ui/globals.css";

const geistSans = localFont({
	src: "./fonts/GeistVF.woff",
	variable: "--font-geist-sans",
});
const geistMono = localFont({
	src: "./fonts/GeistMonoVF.woff",
	variable: "--font-geist-mono",
});

export const metadata: Metadata = {
	title: "Octopus",
	description: "Run Claude Code and Codex in parallel.",
};

export default function RootLayout({
	children,
}: Readonly<{
	children: React.ReactNode;
}>) {
	// next-themes sets the theme class on <html> before React hydrates, so the server markup differs from the client.
	return (
		<html lang="en" className={`${geistSans.variable} ${geistMono.variable}`} suppressHydrationWarning>
			<body className="h-screen overflow-hidden font-sans antialiased">
				<ThemeProvider attribute="class" defaultTheme="dark" enableSystem disableTransitionOnChange>
					{children}
				</ThemeProvider>
			</body>
		</html>
	);
}
