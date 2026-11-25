import { defineConfig } from "@playwright/test";

export default defineConfig({
	testDir: "./tests/browser",
	testMatch: "**/*.browser.ts",
	use: { baseURL: process.env.STUDIO_BASE_URL ?? "http://127.0.0.1:3000" },
});
