// Bun imports `.sql` files as text with `with { type: "text" }`, which embeds them in compiled binaries.
declare module "*.sql" {
	const text: string;
	export default text;
}
