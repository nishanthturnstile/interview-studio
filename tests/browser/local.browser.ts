import { expect, test } from "@playwright/test";

test("shows readiness from the same-origin API", async ({ page }) => {
	const health = page.waitForResponse(
		(response) => new URL(response.url()).pathname === "/api/health",
	);
	await page.goto("/");
	const response = await health;
	expect(response.status()).toBe(200);
	expect(new URL(response.url()).origin).toBe(new URL(page.url()).origin);
	await expect(
		page.getByRole("heading", { name: "Interview Studio" }),
	).toBeVisible();
	await expect(page.getByRole("status")).toHaveText("All services ready");
	await expect(page.getByText("Ready", { exact: true })).toHaveCount(3);
});
