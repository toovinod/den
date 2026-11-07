// Bun imports the generated version file as text, and `bun build --compile` embeds it.
declare module "*/CODEX_VERSION" {
	const version: string;
	export default version;
}
