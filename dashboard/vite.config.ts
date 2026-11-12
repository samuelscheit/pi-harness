import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// `npm run dev` proxies the API to a dashboard server (npm run dashboard, in the repository root).
export default defineConfig({
	plugins: [react()],
	server: { port: 5174, strictPort: true, proxy: { "/api": "http://127.0.0.1:4317" } },
	test: {
		environment: "jsdom",
		environmentOptions: { jsdom: { url: "http://localhost/" } },
		include: ["src/**/*.test.{ts,tsx}"],
		setupFiles: "./src/test/setup.ts",
		css: true,
	},
});
