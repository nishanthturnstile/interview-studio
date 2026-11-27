import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite-plus";

const require = createRequire(import.meta.url);
const excalidrawFonts = join(
	dirname(require.resolve("@excalidraw/excalidraw")),
	"fonts",
);
const fontFiles = new Set(
	readdirSync(excalidrawFonts, { recursive: true, encoding: "utf8" }).filter(
		(path) => path.endsWith(".woff2"),
	),
);
const fontPolicy = "font-src 'self' data:";

const localBoardFonts = {
	name: "studio-whiteboard-fonts",
	configureServer(server: import("vite-plus").ViteDevServer) {
		server.middlewares.use(
			"/excalidraw-assets/fonts",
			(request, response, next) => {
				const path = request.url?.slice(1);
				if (!path || !fontFiles.has(path)) return next();
				response.setHeader("Content-Type", "font/woff2");
				response.end(readFileSync(join(excalidrawFonts, path)));
			},
		);
	},
	generateBundle(this: {
		emitFile: (file: {
			type: "asset";
			fileName: string;
			source: Uint8Array;
		}) => void;
	}) {
		for (const path of fontFiles)
			this.emitFile({
				type: "asset",
				fileName: `excalidraw-assets/fonts/${path}`,
				source: readFileSync(join(excalidrawFonts, path)),
			});
	},
};

export default defineConfig({
	plugins: [react(), tailwindcss(), localBoardFonts],
	resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
	server: {
		headers: { "Content-Security-Policy": fontPolicy },
		host: "127.0.0.1",
		port: 5173,
		strictPort: true,
		proxy: {
			"/api": {
				target: process.env.STUDIO_API_ORIGIN ?? "http://127.0.0.1:3000",
				ws: true,
			},
			"/pdf-assets": process.env.STUDIO_API_ORIGIN ?? "http://127.0.0.1:3000",
		},
	},
});
