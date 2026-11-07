/** @type {import('next').NextConfig} */
const nextConfig = {
	// Tauri loads the UI from files on disk, so it has to be a static export.
	output: "export",
	transpilePackages: ["@repo/contracts"],
};

export default nextConfig;
