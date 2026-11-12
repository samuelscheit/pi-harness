import { defineConfig, devices } from "@playwright/test";

// Renders every view against a running dashboard server (real data): start one with
// `npm run dashboard` in the repository root, or set DASHBOARD_URL.
export default defineConfig({
	testDir: "./e2e",
	timeout: 90_000,
	fullyParallel: true,
	use: { baseURL: process.env.DASHBOARD_URL ?? "http://127.0.0.1:4317", trace: "retain-on-failure" },
	projects: [
		{ name: "desktop", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 1000 } } },
		{ name: "phone", use: { ...devices["iPhone 14"], browserName: "chromium" } },
	],
});
