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

test("uses the design tokens in both themes and keeps focus visible", async ({
	page,
}) => {
	await page.goto("/");
	const refresh = page.getByRole("button", { name: "Check again" });
	const theme = page.getByRole("button", { name: "Dark mode" });
	const badges = page.getByText("Ready", { exact: true });
	await expect(refresh).toBeEnabled();
	await expect(page.locator("body")).toHaveCSS(
		"background-color",
		"rgb(247, 246, 244)",
	);
	await expect(refresh).toHaveCSS("background-color", "rgb(198, 75, 22)");
	await expect(refresh).toHaveCSS("color", "rgb(255, 255, 255)");
	await expect(refresh).toHaveCSS("height", "40px");
	await expect(refresh).toHaveCSS("border-radius", "4px");
	await expect(badges.first()).toHaveCSS(
		"background-color",
		"rgb(228, 241, 232)",
	);

	await page.keyboard.press("Tab");
	await expect(theme).toBeFocused();
	await page.keyboard.press("Tab");
	await expect(refresh).toBeFocused();
	await expect(refresh).toHaveCSS("outline-color", "rgb(165, 60, 16)");
	await expect(refresh).toHaveCSS("outline-style", "solid");
	await expect(refresh).toHaveCSS("outline-width", "2px");
	await expect(refresh).toHaveCSS("outline-offset", "2px");

	await refresh.hover();
	await expect(refresh).toHaveCSS("background-color", "rgb(173, 62, 16)");
	await page.mouse.down();
	await expect(refresh).toHaveCSS("background-color", "rgb(144, 51, 12)");
	await page.mouse.up();

	await theme.click();
	await expect(theme).toHaveAttribute("aria-pressed", "true");
	await expect(page.locator("body")).toHaveCSS(
		"background-color",
		"rgb(25, 24, 23)",
	);
	await expect(refresh).toHaveCSS("background-color", "rgb(255, 152, 101)");
	await expect(refresh).toHaveCSS("color", "rgb(37, 25, 16)");
	await expect(badges.first()).toHaveCSS("background-color", "rgb(25, 53, 41)");

	await page.setViewportSize({ width: 320, height: 640 });
	await page.reload();
	await expect(theme).toHaveAttribute("aria-pressed", "true");
	await expect(refresh).toBeVisible();
	expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(
		320,
	);
});
