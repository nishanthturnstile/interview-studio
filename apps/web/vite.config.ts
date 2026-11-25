import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite-plus";

export default defineConfig({
	plugins: [react(), tailwindcss()],
	resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
	server: {
		host: "127.0.0.1",
		port: 5173,
		strictPort: true,
		proxy: { "/api": process.env.STUDIO_API_ORIGIN ?? "http://127.0.0.1:3000" },
	},
});
