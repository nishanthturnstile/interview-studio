import { expect, type Page, test } from "@playwright/test";

const inbox = process.env.STUDIO_TEST_MAILPIT_URL;
const directorEmail =
	process.env.STUDIO_TEST_DIRECTOR_EMAIL ?? "director@studio.test";
const password = "Synthetic-studio-104";
const newPassword = "Synthetic-studio-207";

test.skip(!inbox, "Run against an isolated Compose project with Mailpit");

async function mailLink(page: Page, address: string, subject: string) {
	let link: string | undefined;
	await expect
		.poll(async () => {
			const search = new URL("/api/v1/search", inbox);
			search.searchParams.set("query", `to:${address}`);
			const response = await page.request.get(search.href);
			if (!response.ok()) return false;
			const { messages } = await response.json();
			const message = messages?.find(
				(entry: { Subject: string }) => entry.Subject === subject,
			);
			if (!message) return false;
			const email = await page.request.get(
				new URL(`/api/v1/message/${message.ID}`, inbox).href,
			);
			const { Text } = await email.json();
			link = Text.match(/https?:\/\/[^\s]+/)?.[0];
			return Boolean(link);
		})
		.toBe(true);
	if (!link) throw new Error("The expected message had no link");
	return link;
}

async function signup(page: Page, name: string, email: string) {
	await page.goto("/sign-up");
	await page.getByLabel("Full name").fill(name);
	await page.getByLabel("Work email").fill(email);
	await page.getByLabel("Phone number").fill("+1 202 555 0111");
	await page.getByLabel("Password", { exact: true }).fill(password);
	await page.getByRole("button", { name: "Create account" }).click();
}

async function signin(page: Page, email: string, secret = password) {
	await page.goto("/sign-in");
	await page.getByLabel("Work email").fill(email);
	await page.getByLabel("Password", { exact: true }).fill(secret);
	await page.getByRole("button", { name: "Sign in", exact: true }).click();
}

async function checkStaffShell(page: Page) {
	const toggle = page.getByRole("button", { name: "Toggle navigation" });
	const accountMenu = page.getByRole("button", {
		name: "Account menu for Test Director",
	});
	const dashboard = page.getByRole("link", { name: "Dashboard" });
	await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();
	await expect(dashboard).toHaveAttribute("aria-current", "page");
	await toggle.click();
	await expect(toggle).toHaveAttribute("aria-expanded", "false");
	await expect(dashboard).toBeVisible();
	await accountMenu.press("Enter");
	await expect(page.getByRole("menu")).toBeVisible();
	await page.getByRole("menuitemradio", { name: "Dark mode" }).click();
	await expect(page.locator("html")).toHaveClass("dark");
	await accountMenu.click();
	await page.getByRole("menuitem", { name: "Settings" }).click();
	await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
	const theme = page.getByRole("combobox", { name: "Theme" });
	await expect(theme).toContainText("Dark mode");
	await theme.click();
	await page.getByRole("option", { name: "Light mode" }).click();
	await expect(page.locator("html")).not.toHaveClass("dark");
	await toggle.click();

	const desktop = page.viewportSize();
	await page.setViewportSize({ width: 390, height: 844 });
	await expect(dashboard).toBeHidden();
	await toggle.click();
	await expect(page.getByRole("dialog", { name: "Sidebar" })).toBeVisible();
	await accountMenu.click();
	await page.getByRole("menuitem", { name: "Account", exact: true }).click();
	await expect(page.getByRole("heading", { name: "Account" })).toBeVisible();
	await expect(page.getByRole("dialog", { name: "Sidebar" })).toBeHidden();
	await expect(
		page.getByRole("main").getByText(directorEmail, { exact: true }),
	).toBeVisible();
	expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(
		390,
	);

	if (desktop) await page.setViewportSize(desktop);
	await dashboard.click();
}

test("verifies staff, grants roles, and resets a password through Mailpit", async ({
	browser,
	baseURL,
}) => {
	const directorContext = await browser.newContext({ baseURL });
	const panelistContext = await browser.newContext({ baseURL });
	const director = await directorContext.newPage();
	const panelist = await panelistContext.newPage();
	director.setDefaultTimeout(8_000);
	panelist.setDefaultTimeout(8_000);
	const panelistEmail = `panelist-${Date.now()}@studio.test`;
	test.setTimeout(60_000);

	try {
		await panelist.goto("/staff/account");
		await expect(panelist).toHaveURL(/\/sign-in$/);
		await signup(panelist, "Outside user", "outside@example.test");
		await expect(panelist.getByRole("alert")).toContainText("approved domain");
		await signup(director, "Test Director", directorEmail);
		await expect(
			director.getByRole("heading", { name: "Check your inbox" }),
		).toBeVisible();
		const verification = await mailLink(
			director,
			directorEmail,
			"Verify your Interview Studio email",
		);
		expect((await director.request.get(verification)).status()).toBe(200);
		await signin(director, directorEmail);
		await expect(director.getByRole("alert")).toContainText(
			"Verify your work email",
		);
		expect((await director.request.get("/api/staff/me")).status()).toBe(401);
		await director.goto(verification);
		await director
			.getByRole("button", { name: "Verify email", exact: true })
			.click();
		await expect(director.getByRole("status")).toContainText("Email verified");
		await signin(director, directorEmail);
		await expect(director.getByText("Director", { exact: true })).toBeVisible();
		await checkStaffShell(director);

		await signup(panelist, "Test Panelist", panelistEmail);
		await expect(
			panelist.getByRole("heading", { name: "Check your inbox" }),
		).toBeVisible();
		await panelist.getByLabel("Work email").fill(panelistEmail);
		await panelist.getByRole("button", { name: "Resend link" }).click();
		await expect(panelist.getByRole("status")).toContainText(
			"a new link is on its way",
		);
		await panelist.goto(
			await mailLink(
				panelist,
				panelistEmail,
				"Verify your Interview Studio email",
			),
		);
		await panelist
			.getByRole("button", { name: "Verify email", exact: true })
			.click();
		await expect(panelist.getByRole("status")).toContainText("Email verified");
		await signin(panelist, panelistEmail);
		await expect(panelist.getByText("Panelist", { exact: true })).toBeVisible();
		await expect(panelist.getByRole("link", { name: "Drives" })).toHaveCount(0);
		await panelist.goto("/staff/drives");
		await expect(panelist.getByRole("alert")).toContainText(
			"Drives are available to HR and directors.",
		);
		await panelist.getByRole("link", { name: "Dashboard" }).click();

		const panelistMe = await (
			await panelist.request.get("/api/staff/me")
		).json();
		expect((await panelist.request.get("/api/staff/access")).status()).toBe(
			403,
		);
		expect(
			(
				await panelist.request.patch(`/api/staff/access/${panelistMe.id}`, {
					headers: { origin: String(baseURL) },
					data: { role: "director" },
				})
			).status(),
		).toBe(403);
		expect(
			(
				await director.request.patch(`/api/staff/access/${panelistMe.id}`, {
					headers: { origin: "http://outside.test" },
					data: { role: "hr" },
				})
			).status(),
		).toBe(403);

		await director.getByRole("link", { name: "Manage staff access" }).click();
		const row = director
			.getByRole("listitem")
			.filter({ hasText: panelistEmail });
		for (const role of ["HR", "Director"]) {
			await row
				.getByRole("button", { name: "Change role for Test Panelist" })
				.click();
			const dialog = director.getByRole("dialog", {
				name: "Grant staff access",
			});
			await dialog.getByRole("combobox", { name: "New role" }).click();
			await director.getByRole("option", { name: role, exact: true }).click();
			await dialog.getByRole("button", { name: "Grant access" }).click();
			await expect(row.getByText(role, { exact: true })).toBeVisible();
			await panelist.reload();
			await expect(panelist.getByText(role, { exact: true })).toBeVisible();
			const drives = panelist.getByRole("link", { name: "Drives" });
			await drives.click();
			await expect(
				panelist.getByRole("heading", { name: "Drives" }),
			).toBeVisible();
			await expect(drives).toHaveAttribute("aria-current", "page");
			await panelist.getByRole("link", { name: "Dashboard" }).click();
		}

		await director.goto("/forgot-password");
		await director.getByLabel("Work email").fill(panelistEmail);
		await director.getByRole("button", { name: "Send reset link" }).click();
		await expect(director.getByRole("status")).toContainText(
			"a reset link is on its way",
		);
		const reset = await mailLink(
			director,
			panelistEmail,
			"Reset your Interview Studio password",
		);
		await director.goto(reset);
		await director
			.getByLabel("New password", { exact: true })
			.fill(newPassword);
		await director
			.getByLabel("Confirm new password", { exact: true })
			.fill(newPassword);
		await director.getByRole("button", { name: "Change password" }).click();
		await expect(director.getByRole("status")).toContainText(
			"Password changed",
		);
		await panelist.reload();
		await expect(
			panelist.getByRole("heading", { name: "Staff sign in" }),
		).toBeVisible();
		await signin(panelist, panelistEmail);
		await expect(panelist.getByRole("alert")).toContainText(
			"email or password is incorrect",
		);
		await signin(panelist, panelistEmail, newPassword);
		await expect(panelist.getByText("Director", { exact: true })).toBeVisible();
		await director.goto(reset);
		await expect(director.getByRole("alert")).toContainText(
			"invalid, expired, or already used",
		);
		await panelist
			.getByRole("button", { name: "Account menu for Test Panelist" })
			.click();
		await panelist.getByRole("menuitem", { name: "Sign out" }).click();
		await expect(
			panelist.getByRole("heading", { name: "Staff sign in" }),
		).toBeVisible();
		expect((await panelist.request.get("/api/staff/me")).status()).toBe(401);
		const statuses = [];
		for (let attempt = 0; attempt < 6; attempt++) {
			const response = await panelist.request.post("/api/auth/sign-in/email", {
				headers: {
					origin: String(baseURL),
					"x-forwarded-for": `192.0.2.${attempt + 1}`,
				},
				data: { email: "unknown@studio.test", password },
			});
			statuses.push(response.status());
		}
		expect(statuses).toContain(429);
	} finally {
		await Promise.allSettled([
			directorContext.close(),
			panelistContext.close(),
		]);
	}
});
