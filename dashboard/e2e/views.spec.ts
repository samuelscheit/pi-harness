import { expect, type Page, test } from "@playwright/test";

// Every view, as a person opens it, with its first heading; screenshots go to test-results/screens.
const VIEWS: [string, string, RegExp][] = [
	["overview", "/?range=all", /What drove spend/],
	["drivers", "/drivers?range=all", /Spend by prompt content/],
	["drivers-tool", "/drivers?range=all&group=tool", /Spend by tool/],
	["context", "/context?range=all", /Carry cost by tool/],
	["sessions", "/sessions?range=all", /^Sessions$/],
	["waste", "/waste?range=all", /Cache rebuilds by cause/],
	["subagents", "/subagents?range=all", /New or resume, per subagent/],
	["versions", "/versions?range=all", /Cost per request by version/],
	["overview-claude-code", "/?range=30d&source=claude-code", /What drove spend/],
];

async function settle(page: Page) {
	await expect(page.getByText(/Loading/)).toHaveCount(0, { timeout: 60_000 });
	await expect(page.getByRole("status")).toHaveCount(0, { timeout: 120_000 });
	await expect(page.getByText(/Loading/)).toHaveCount(0, { timeout: 60_000 });
}

for (const [name, path, heading] of VIEWS) {
	test(name, async ({ page }, info) => {
		const errors: string[] = [];
		page.on("pageerror", (error) => errors.push(error.message));
		page.on("console", (message) => message.type() === "error" && errors.push(message.text()));
		await page.goto(path);
		await settle(page);
		await expect(page.getByRole("heading", { name: heading }).first()).toBeVisible();
		// Nothing wider than the screen, apart from tables that scroll in their own box.
		const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
		expect(overflow).toBeLessThanOrEqual(0);
		await page.screenshot({ path: `test-results/screens/${name}-${info.project.name}.png`, fullPage: true });
		expect(errors).toEqual([]);
	});
}

test("session detail from the most expensive session", async ({ page }, info) => {
	await page.goto("/sessions?range=all");
	await settle(page);
	await page.locator("table a").first().click();
	await settle(page);
	await expect(page.getByRole("img", { name: /Prompt size and cost per request/ })).toBeVisible();
	await expect(page.getByRole("heading", { name: "Subagents" })).toBeVisible();
	await page.screenshot({ path: `test-results/screens/session-${info.project.name}.png`, fullPage: true });
});
