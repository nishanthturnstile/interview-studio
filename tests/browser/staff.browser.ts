import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { expect, type Page, test } from "@playwright/test";
import { checkIntakeRecovery } from "./drive-recovery.ts";

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
	const desktop = page.viewportSize();
	await page.setViewportSize({ width: 1680, height: 900 });
	const toggle = page.getByRole("button", { name: "Toggle navigation" });
	const sidebar = page.locator('[data-slot="sidebar-container"]');
	const sidebarGap = async () => {
		const [button, panel] = await Promise.all([
			toggle.boundingBox(),
			sidebar.boundingBox(),
		]);
		return button && panel ? button.x - (panel.x + panel.width) : NaN;
	};
	const accountMenu = page.getByRole("button", {
		name: "Account menu for Test Director",
	});
	const dashboard = page.getByRole("link", { name: "Dashboard" });
	await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();
	await expect(dashboard).toHaveAttribute("aria-current", "page");
	await expect(toggle).toHaveAttribute("aria-expanded", "true");
	await expect.poll(sidebarGap).toBeCloseTo(12, 0);
	await toggle.click();
	await expect(toggle).toHaveAttribute("aria-expanded", "false");
	await expect.poll(sidebarGap).toBeCloseTo(12, 0);
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
	await expect(toggle).toHaveAttribute("aria-expanded", "true");
	await expect.poll(sidebarGap).toBeCloseTo(12, 0);

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
		await expect(panelist).toHaveURL(/\/staff\/?$/);
		await expect(
			panelist.getByRole("heading", { name: "Dashboard" }),
		).toBeVisible();

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

const fixturePath = (name: string) =>
	fileURLToPath(new URL(`../fixtures/intake/${name}`, import.meta.url));

async function signinWhenAvailable(page: Page, address: string) {
	await expect
		.poll(
			async () => {
				const attempt = page.waitForResponse(
					(response) =>
						new URL(response.url()).pathname === "/api/auth/sign-in/email",
				);
				await signin(page, address);
				return (await attempt).status();
			},
			{ intervals: [11_000], timeout: 25_000 },
		)
		.toBe(200);
}

async function verifyAndSignIn(page: Page, name: string, address: string) {
	await signup(page, name, address);
	await expect(
		page.getByRole("heading", { name: "Check your inbox" }),
	).toBeVisible();
	await page.goto(
		await mailLink(page, address, "Verify your Interview Studio email"),
	);
	await page.getByRole("button", { name: "Verify email", exact: true }).click();
	await expect(page.getByRole("status")).toContainText("Email verified");
	await signinWhenAvailable(page, address);
	await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();
}

test("prepares a drive with original files, independent candidate review, and read-only director access", async ({
	browser,
	baseURL,
}) => {
	test.setTimeout(process.env.STUDIO_TEST_COMPOSE_PROJECT ? 180_000 : 90_000);
	const contexts = await Promise.all(
		Array.from({ length: 3 }, () => browser.newContext({ baseURL })),
	);
	const [director, hr, panelist] = await Promise.all(
		contexts.map((context) => context.newPage()),
	);
	const timestamp = Date.now();
	const hrEmail = `intake-${timestamp}@studio.test`;
	const name = `Synthetic intake ${timestamp}`;
	const origin = String(baseURL);
	const write = { origin };
	const root = "/api/staff/drives";
	const pdf = await readFile(fixturePath("text-resume.pdf"));
	const scan = await readFile(fixturePath("scan-resume.pdf"));
	const media = "application/pdf";
	const docx =
		"application/vnd.openxmlformats-officedocument.wordprocessingml.document";

	try {
		await signinWhenAvailable(director, directorEmail);
		await expect(
			director.getByRole("heading", { name: "Dashboard" }),
		).toBeVisible();
		await verifyAndSignIn(hr, "Synthetic HR", hrEmail);
		await verifyAndSignIn(
			panelist,
			"Synthetic Panelist",
			`observer-${timestamp}@studio.test`,
		);
		const identity = await (await hr.request.get("/api/staff/me")).json();
		const grant = await director.request.patch(
			`/api/staff/access/${identity.id}`,
			{ headers: write, data: { role: "hr" } },
		);
		expect(grant.status()).toBe(200);
		await hr.reload();
		await hr.getByRole("link", { name: "Drives" }).click();
		await hr.getByRole("button", { name: "New drive" }).press("Enter");
		await hr.getByLabel("Drive name").fill(name);
		await hr.getByRole("button", { name: "Create drive" }).click();
		await expect(hr.getByRole("heading", { name })).toBeVisible();
		const driveUrl = new URL(hr.url()).pathname;
		const driveId = driveUrl.split("/").at(-1);
		const api = `${root}/${driveId}`;
		await hr.reload();
		await expect(hr.getByRole("heading", { name })).toBeVisible();
		await hr.setViewportSize({ width: 1440, height: 920 });
		const [descriptionBounds, intakeBounds, queueBounds, skillsBounds] =
			await Promise.all([
				hr.locator("#job-description").boundingBox(),
				hr.locator("#resume-intake").boundingBox(),
				hr.getByRole("region", { name: "Candidate review" }).boundingBox(),
				hr.getByRole("region", { name: "Scorecard skills" }).boundingBox(),
			]);
		if (!descriptionBounds || !intakeBounds || !queueBounds || !skillsBounds)
			throw new Error("Missing drive sections");
		expect(descriptionBounds.y).toBeCloseTo(intakeBounds.y, 0);
		expect(intakeBounds.height).toBeCloseTo(descriptionBounds.height, 0);
		expect(descriptionBounds.x + descriptionBounds.width).toBeLessThan(
			intakeBounds.x,
		);
		expect(queueBounds.x).toBeCloseTo(descriptionBounds.x, 0);
		expect(queueBounds.x + queueBounds.width).toBeCloseTo(
			intakeBounds.x + intakeBounds.width,
			0,
		);
		expect(queueBounds.y).toBeGreaterThan(
			Math.max(
				descriptionBounds.y + descriptionBounds.height,
				intakeBounds.y + intakeBounds.height,
			),
		);
		expect(skillsBounds.y).toBeGreaterThan(queueBounds.y + queueBounds.height);

		const description = hr.getByRole("textbox", {
			name: "Job description text",
		});
		const writtenDescription = Array.from(
			{ length: 24 },
			(_, index) =>
				`Responsibility ${index + 1}: Build and document reliable services.`,
		).join("\n");
		await description.fill(writtenDescription);
		await hr.getByRole("button", { name: "Save description" }).click();
		await expect(hr.locator("#job-description").getByRole("status")).toHaveText(
			"Saved",
		);
		await hr.reload();
		await expect(description).toHaveValue(writtenDescription);
		expect(
			await description.evaluate(
				(element) => element.scrollHeight > element.clientHeight,
			),
		).toBe(true);
		const staleDescription = await hr.request.put(`${api}/job-description`, {
			headers: write,
			data: { revision: 0, text: "Stale changes" },
		});
		expect(staleDescription.status()).toBe(409);
		expect((await staleDescription.json()).current.editedText).toBe(
			writtenDescription,
		);

		await hr
			.getByLabel("Choose job description")
			.setInputFiles({ name: "Rôle.pdf", mimeType: media, buffer: pdf });
		await expect(hr.getByRole("heading", { name: "Rôle.pdf" })).toBeVisible();
		const jdDownload = hr.getByRole("link", {
			name: "Download original Rôle.pdf",
		});
		await expect(jdDownload).toBeVisible();
		const jdPath = await jdDownload.getAttribute("href");
		if (!jdPath) throw new Error("No JD download route");
		const original = await hr.request.get(jdPath);
		expect(original.status()).toBe(200);
		expect(original.headers()["content-disposition"]).toContain(
			"R%C3%B4le.pdf",
		);
		expect(
			createHash("sha256")
				.update(await original.body())
				.digest("hex"),
		).toBe(createHash("sha256").update(pdf).digest("hex"));

		await expect(
			hr.getByRole("button", { name: "Use text from file" }),
		).toBeVisible();
		await expect(description).toHaveValue(writtenDescription);
		await expect
			.poll(() =>
				hr.locator("#resume-intake").evaluate((element) => {
					const description = document.querySelector("#job-description");
					return (
						element.getBoundingClientRect().height -
						(description?.getBoundingClientRect().height ?? 0)
					);
				}),
			)
			.toBeCloseTo(0, 0);

		const files = await Promise.all(
			[
				"text-resume.pdf",
				"text-resume.docx",
				"scan-resume.pdf",
				"ocr-resume.pdf",
				"expanded-limit.docx",
			].map(async (name) => ({
				name,
				type: name.endsWith(".pdf") ? media : docx,
				contents: (await readFile(fixturePath(name))).toString("base64"),
			})),
		);
		files.push({
			name: "image-resume.png",
			type: "image/png",
			contents: await hr.evaluate(() => {
				const canvas = document.createElement("canvas");
				canvas.width = 1000;
				canvas.height = 1200;
				const context = canvas.getContext("2d");
				if (!context) throw new Error("Missing canvas");
				context.fillStyle = "white";
				context.fillRect(0, 0, canvas.width, canvas.height);
				context.fillStyle = "black";
				context.font = "36px Arial";
				for (const [index, line] of [
					"Name: Avery Chen",
					"Email: avery.chen@example.test",
					"Total experience: 9 years",
					"Java Software Engineer",
				].entries()) {
					context.fillText(line, 80, 105 + index * 60);
				}
				return canvas.toDataURL("image/png").split(",")[1];
			}),
		});
		const transfer = await hr.evaluateHandle((files) => {
			const transfer = new DataTransfer();
			for (const { name, type, contents } of files) {
				const bytes = Uint8Array.from(atob(contents), (character) =>
					character.charCodeAt(0),
				);
				transfer.items.add(new File([bytes], name, { type }));
			}
			return transfer;
		}, files);
		const dropzone = hr.locator("#resume-dropzone");
		await dropzone.dispatchEvent("dragenter", { dataTransfer: transfer });
		await expect(dropzone.getByText("Release to upload")).toBeVisible();
		await dropzone.dispatchEvent("drop", { dataTransfer: transfer });
		await transfer.dispose();
		const queue = hr.getByRole("region", { name: "Candidate review" });
		const row = (filename: string) =>
			queue.getByRole("button", { name: `Review ${filename}`, exact: true });
		const sheet = hr.getByRole("dialog", { name: "Review candidate" });
		const preview = sheet.getByRole("region", { name: "Resume preview" });
		const editor = sheet.getByRole("region", { name: "Candidate details" });
		const viewResume = sheet.getByRole("button", { name: "View resume" });
		const closePreview = async () => {
			await preview
				.getByRole("button", { name: /Hide resume|Back to candidate/ })
				.click();
			await expect(preview).toHaveCount(0);
			await expect(viewResume).toBeFocused();
		};
		const closeReview = async () => {
			await sheet.getByRole("button", { name: "Close", exact: true }).click();
			await expect(sheet).toHaveCount(0);
		};
		await expect(row("text-resume.pdf")).toContainText("Text extracted", {
			timeout: 25_000,
		});
		await expect(row("text-resume.docx")).toContainText("Text extracted", {
			timeout: 25_000,
		});
		await expect(row("scan-resume.pdf")).toContainText("Needs manual review", {
			timeout: 25_000,
		});
		await expect(row("ocr-resume.pdf")).toContainText(
			"Text extracted with OCR",
			{
				timeout: 25_000,
			},
		);
		await expect(row("text-resume.pdf")).not.toContainText("with OCR");
		await expect(row("image-resume.png")).toContainText(
			"Text extracted with OCR",
			{
				timeout: 25_000,
			},
		);
		await expect(row("expanded-limit.docx")).toContainText(
			"Needs manual review",
			{ timeout: 25_000 },
		);
		const { items } = await (
			await hr.request.get(`${api}/review-queue`)
		).json();
		expect(items).toHaveLength(6);
		const wordId = items.find(
			(item: { document: { filename: string } }) =>
				item.document.filename === "text-resume.docx",
		).document.id;
		const wordPreview = `${api}/documents/${wordId}/preview`;
		const wordResponse = await hr.request.get(wordPreview);
		expect(wordResponse.status()).toBe(200);
		expect(wordResponse.headers()["content-type"]).toContain("text/plain");
		expect(wordResponse.headers()["cache-control"]).toBe("private, no-store");
		expect(
			(
				await (
					await hr.request.get(`${api}/review-queue?status=needs_attention`)
				).json()
			).total,
		).toBe(2);
		await row("expanded-limit.docx").click();
		await expect(
			sheet.getByText("The document exceeded an extraction limit."),
		).toBeVisible();
		await viewResume.click();
		await expect(preview.getByRole("alert")).toContainText(
			"couldn’t be displayed",
		);
		await closePreview();
		await closeReview();

		await row("image-resume.png").click();
		await viewResume.click();
		const image = preview.getByRole("img", {
			name: "Resume scan of image-resume.png",
		});
		await expect
			.poll(() =>
				image.evaluate((element: HTMLImageElement) => element.naturalWidth),
			)
			.toBe(1000);
		await closePreview();
		await closeReview();

		await row("ocr-resume.pdf").click();
		await expect(sheet.getByLabel("Candidate name")).toHaveValue("");
		await sheet
			.getByRole("button", { name: "Fill empty fields from suggestions" })
			.click();
		await expect(sheet.getByLabel("Candidate name")).toHaveValue("LEENA VARMA");
		await expect(sheet.getByLabel("Candidate email")).toHaveValue(
			"leena.varma@example.test",
		);
		await expect(sheet.getByLabel("Years of experience")).toHaveValue("8.5");
		const suggestions = sheet.getByRole("button", {
			name: "Extraction suggestions",
		});
		await expect(suggestions).toHaveAttribute("aria-expanded", "false");
		await suggestions.click();
		await expect(suggestions).toHaveAttribute("aria-expanded", "true");
		await expect(
			sheet
				.locator('[data-slot="collapsible-content"]')
				.getByText("leena.varma@example.test"),
		).toBeVisible();
		await suggestions.click();
		const desktop = hr.viewportSize();
		await viewResume.click();
		await expect(preview.locator('[data-rendered="true"]')).toHaveCount(1);
		await expect(editor).toBeVisible();
		const [resumeBounds, editorBounds] = await Promise.all([
			preview.boundingBox(),
			editor.boundingBox(),
		]);
		if (!resumeBounds || !editorBounds) throw new Error("Missing review panes");
		expect(resumeBounds.x + resumeBounds.width).toBeLessThanOrEqual(
			editorBounds.x + 1,
		);
		const canvas = await preview
			.locator('[data-rendered="true"] canvas')
			.elementHandle();
		await editor.getByLabel("Candidate name").fill("Leena Varma");
		await expect(
			preview.locator('[data-rendered="true"] canvas'),
		).toBeVisible();
		expect(await canvas?.evaluate((element) => element.isConnected)).toBe(true);
		await editor.getByLabel("Candidate name").fill("LEENA VARMA");
		await hr.setViewportSize({ width: 390, height: 740 });
		await expect(editor).toBeHidden();
		await expect(
			preview.getByRole("button", { name: "Back to candidate" }),
		).toBeVisible();
		await expect(preview.locator('[data-rendered="true"]')).toHaveCount(1);
		await preview.getByRole("button", { name: "Zoom in" }).click();
		const pages = preview.getByRole("region", { name: "Resume pages" });
		await expect
			.poll(() =>
				pages.evaluate(
					(element) =>
						element.scrollWidth > element.clientWidth &&
						element.scrollHeight > element.clientHeight,
				),
			)
			.toBe(true);
		await pages.focus();
		await hr.keyboard.press("End");
		await expect
			.poll(() => pages.evaluate((element) => element.scrollTop))
			.toBeGreaterThan(0);
		await hr.keyboard.press("Escape");
		await expect(preview).toHaveCount(0);
		await expect(viewResume).toBeFocused();
		await expect(sheet.getByLabel("Candidate name")).toHaveValue("LEENA VARMA");
		if (desktop) await hr.setViewportSize(desktop);
		await sheet.getByRole("button", { name: "Save draft" }).click();
		await expect(
			sheet.getByRole("status").filter({ hasText: "Candidate saved." }),
		).toBeVisible();
		await closeReview();

		for (const filename of ["text-resume.pdf", "text-resume.docx"]) {
			await row(filename).click();
			if (filename.endsWith(".docx")) {
				await viewResume.click();
				await expect(
					preview.getByRole("article", { name: "Word document" }),
				).toContainText("FIXTURE@EXAMPLE.TEST");
				await closePreview();
			}
			await expect(sheet.getByLabel("Candidate name")).toHaveValue("");
			await sheet
				.getByRole("button", { name: "Fill empty fields from suggestions" })
				.click();
			await sheet.getByRole("button", { name: "Save draft" }).click();
			await expect(
				sheet.getByRole("status").filter({ hasText: "Candidate saved." }),
			).toBeVisible();
			await sheet.getByRole("button", { name: "Confirm candidate" }).click();
			if (filename.endsWith(".pdf")) {
				await expect(
					sheet.getByText("Confirmed", { exact: true }),
				).toBeVisible();
			} else {
				await sheet
					.getByRole("button", {
						name: "Link to confirmed candidate as duplicate",
					})
					.click();
				await expect(
					sheet.getByText("Duplicate", { exact: true }),
				).toBeVisible();
			}
			await closeReview();
		}
		await expect(row("text-resume.pdf")).toContainText("Confirmed");
		await expect(row("text-resume.docx")).toContainText("Duplicate");

		await row("scan-resume.pdf").click();
		await expect(sheet.getByText("No readable text was found.")).toBeVisible();
		await sheet.getByLabel("Candidate name").fill("Synthetic Manual");
		await sheet.getByLabel("Candidate email").fill("manual@example.test");
		await sheet.getByRole("button", { name: "Close", exact: true }).click();
		await hr
			.getByRole("dialog", { name: "Discard candidate edits?" })
			.getByRole("button", { name: "Keep editing" })
			.click();
		await expect(sheet.getByLabel("Candidate name")).toHaveValue(
			"Synthetic Manual",
		);
		await sheet.getByRole("button", { name: "Save draft" }).click();
		await sheet.getByRole("button", { name: "Confirm candidate" }).click();
		await expect(sheet.getByText("Confirmed", { exact: true })).toBeVisible();
		await closeReview();
		await expect(row("scan-resume.pdf")).toContainText("Confirmed");
		const search = queue.getByRole("searchbox", { name: "Search candidates" });
		const results = queue.getByRole("region", { name: "Candidate results" });
		await search.focus();
		const layout = () =>
			hr.evaluate(() => ({
				scroll: window.scrollY,
				review: document
					.getElementById("candidate-review")
					?.getBoundingClientRect().top,
				skills: document
					.getElementById("scorecard-skills")
					?.getBoundingClientRect().top,
			}));
		const beforeSearch = await layout();
		const queuePath = `${api}/review-queue`;
		const oldQuery = "obsolete candidate search";
		const oldRequest = (url: URL) =>
			url.pathname === queuePath && url.searchParams.get("q") === oldQuery;
		let releaseSearch = () => {};
		const holdSearch = new Promise<void>((resolve) => {
			releaseSearch = resolve;
		});
		await hr.route(oldRequest, async (route) => {
			const response = await route.fetch();
			await holdSearch;
			// A newer query can cancel the request before the older response arrives.
			await route.fulfill({ response }).catch(() => undefined);
		});
		try {
			await search.fill(oldQuery);
			await expect(results).toHaveAttribute("aria-busy", "true");
			await expect(results.getByRole("listitem")).toHaveCount(6);
			expect(await layout()).toEqual(beforeSearch);
			await search.fill("manual@example.test");
			await expect(results.getByRole("listitem")).toHaveCount(1);
			await expect(row("scan-resume.pdf")).toBeVisible();
			await expect(search).toBeFocused();
			expect(await layout()).toEqual(beforeSearch);
		} finally {
			releaseSearch();
			await hr.unroute(oldRequest);
		}
		await expect(results.getByRole("listitem")).toHaveCount(1);
		await search.fill("no match for this review");
		await expect(results.getByText("No matching resumes")).toBeVisible();
		expect(await layout()).toEqual(beforeSearch);
		await results.getByRole("button", { name: "Clear filters" }).click();
		await expect(search).toBeFocused();
		await expect(search).toHaveValue("");
		await expect(results.getByRole("listitem")).toHaveCount(6);

		for (const round of ["L1", "L2"]) {
			await hr.getByRole("button", { name: `Add ${round} skill` }).click();
			await hr.getByRole("button", { name: `Add ${round} skill` }).click();
			await hr
				.getByLabel(`${round} skill 1`, { exact: true })
				.fill("Problem solving");
			await hr
				.getByLabel(`${round} skill 2`, { exact: true })
				.fill("Communication");
			await hr
				.getByRole("button", { name: `Move ${round} skill 2 up` })
				.click();
			await expect(
				hr.getByLabel(`${round} skill 1`, { exact: true }),
			).toHaveValue("Communication");
			await hr.getByRole("button", { name: `Save ${round} skills` }).click();
			await hr.getByRole("button", { name: `Mark ${round} reviewed` }).click();
			await expect(hr.getByText(`${round} marked reviewed.`)).toBeVisible();
		}
		await hr
			.getByLabel("L1 skill 2", { exact: true })
			.fill("Structured problem solving");
		await hr.getByRole("button", { name: "Save L1 skills" }).click();
		await expect(
			hr.getByRole("button", { name: "Mark L1 reviewed" }),
		).toBeEnabled();

		await hr.setViewportSize({ width: 390, height: 844 });
		expect(await hr.evaluate(() => document.documentElement.scrollWidth)).toBe(
			390,
		);
		const [mobileDescription, mobileIntake, mobileQueue] = await Promise.all([
			hr.locator("#job-description").boundingBox(),
			hr.locator("#resume-intake").boundingBox(),
			queue.boundingBox(),
		]);
		if (!mobileDescription || !mobileIntake || !mobileQueue)
			throw new Error("Missing mobile drive sections");
		expect(mobileDescription.x).toBeCloseTo(mobileIntake.x, 0);
		expect(mobileIntake.y).toBeGreaterThan(
			mobileDescription.y + mobileDescription.height,
		);
		expect(mobileQueue.y).toBeGreaterThan(mobileIntake.y + mobileIntake.height);
		const [chooser] = await Promise.all([
			hr.waitForEvent("filechooser"),
			hr.getByRole("button", { name: "Browse files" }).click(),
		]);
		expect(chooser.isMultiple()).toBe(true);
		await hr.getByRole("button", { name: "Toggle navigation" }).click();
		await hr
			.getByRole("button", { name: "Account menu for Synthetic HR" })
			.click();
		await hr.getByRole("menuitemradio", { name: "Dark mode" }).click();
		await expect(hr.locator("html")).toHaveClass("dark");
		await hr.keyboard.press("Escape");
		await hr.getByRole("button", { name: "Browse files" }).focus();
		await hr.keyboard.press("Shift+Tab");
		await expect(hr.locator(":focus-visible")).toHaveCount(1);

		await director.goto(driveUrl);
		await expect(director.getByRole("heading", { name })).toBeVisible();
		await expect(
			director.getByText("Structured problem solving"),
		).toBeVisible();
		await expect(director.getByText("Resume intake")).toHaveCount(0);
		await director.setViewportSize({ width: 360, height: 800 });
		expect(
			await director.evaluate(() => document.documentElement.scrollWidth),
		).toBe(360);
		const overview = await (await director.request.get(api)).json();
		expect(overview.counts).toEqual({
			resumes: 6,
			drafts: 3,
			confirmed: 2,
			duplicates: 1,
		});
		expect(
			overview.skills.map((set: { reviewedAt: string | null }) =>
				Boolean(set.reviewedAt),
			),
		).toEqual([false, true]);
		expect(JSON.stringify(overview)).not.toMatch(
			/fixture@example|\.pdf|objectKey|extractedText|candidateId/,
		);
		const pagination = await director.request.get(`${root}?limit=1`);
		expect(pagination.status()).toBe(200);
		await expect(panelist.getByRole("link", { name: "Drives" })).toHaveCount(0);
		const panelistFetches: string[] = [];
		panelist.on("request", (request) => {
			if (new URL(request.url()).pathname.startsWith(root))
				panelistFetches.push(request.url());
		});
		await panelist.goto(driveUrl);
		await expect(panelist).toHaveURL(/\/staff\/?$/);
		expect(panelistFetches).toHaveLength(0);
		const denied = [
			["GET", `${api}/documents`],
			["GET", `${api}/job-description`],
			["PUT", `${api}/job-description`],
			["GET", `${api}/candidates`],
			["GET", `${api}/candidates/${randomUUID()}`],
			["GET", `${api}/review-queue`],
			["GET", jdPath],
			["GET", wordPreview],
			["POST", root],
			["POST", `${api}/documents?kind=resume`],
			["PUT", `${api}/skills/l1`],
			["POST", `${api}/skills/l2/review`],
			["PATCH", `${api}/candidates/${randomUUID()}`],
			["POST", `${api}/candidates/${randomUUID()}/confirm`],
			["POST", `${api}/candidates/${randomUUID()}/duplicate`],
		];
		for (const [method, path] of denied) {
			for (const session of [director, panelist]) {
				expect(
					(
						await session.request.fetch(path, { method, headers: write })
					).status(),
				).toBe(403);
			}
		}
		for (const path of [root, api, jdPath])
			expect((await panelist.request.get(path)).status()).toBe(403);
		const anonymous = await browser.newContext({ baseURL });
		try {
			expect((await anonymous.request.get(api)).status()).toBe(401);
			expect((await anonymous.request.get(wordPreview)).status()).toBe(401);
		} finally {
			await anonymous.close();
		}

		const createKey = randomUUID();
		const create = (name: string) =>
			hr.request.post(root, {
				headers: { ...write, "Idempotency-Key": createKey },
				data: { name },
			});
		const created = await create("Independent candidacies");
		expect(created.status()).toBe(201);
		const second = await created.json();
		const replayed = await create(" Independent   candidacies ");
		expect(replayed.status()).toBe(200);
		expect(await replayed.json()).toEqual(second);
		expect((await create("Changed payload")).status()).toBe(409);
		const secondApi = `${root}/${second.id}`;
		expect(
			(
				await hr.request.get(jdPath.replace(String(driveId), second.id))
			).status(),
		).toBe(404);
		expect(
			(
				await hr.request.get(wordPreview.replace(String(driveId), second.id))
			).status(),
		).toBe(404);

		const upload = (
			path: string,
			filename: string,
			data: Buffer,
			key = randomUUID(),
			mime = media,
			jdRevision?: number,
		) =>
			hr.request.post(
				`${path}/documents?kind=${jdRevision === undefined ? "resume" : "job_description"}`,
				{
					headers: {
						...write,
						"X-Upload-Filename": encodeURIComponent(filename),
						"Content-Type": mime,
						"Idempotency-Key": key,
						...(jdRevision !== undefined && {
							"X-JD-Revision": String(jdRevision),
						}),
					},
					data,
				},
			);
		const invalid = await upload(
			secondApi,
			"mismatched.pdf",
			Buffer.from("not a PDF"),
		);
		expect(invalid.status()).toBe(415);
		const tooLarge = await upload(
			secondApi,
			"oversized.pdf",
			Buffer.alloc(10 * 1024 * 1024 + 1),
		);
		expect(tooLarge.status()).toBe(413);
		const identityCookies = await hr.context().cookies();
		let chunks = 0;
		const streaming = new ReadableStream<Uint8Array>({
			pull(controller) {
				if (chunks++ === 11) return controller.close();
				controller.enqueue(new Uint8Array(1024 * 1024));
			},
		});
		const streamingResponse = await fetch(
			`${origin}${secondApi}/documents?kind=resume`,
			{
				method: "POST",
				headers: {
					...write,
					cookie: identityCookies
						.map(({ name, value }) => `${name}=${value}`)
						.join("; "),
					"X-Upload-Filename": "stream.pdf",
					"Content-Type": media,
					"Idempotency-Key": randomUUID(),
				},
				body: streaming,
				duplex: "half",
				signal: AbortSignal.timeout(15_000),
			} as RequestInit & { duplex: "half" },
		);
		expect(streamingResponse.status).toBe(413);
		await streamingResponse.body?.cancel();
		expect(
			(await (await hr.request.get(`${secondApi}/documents`)).json()).items,
		).toEqual([]);

		const key = randomUUID();
		const firstUpload = await upload(secondApi, "replay.pdf", pdf, key);
		expect(firstUpload.status()).toBe(201);
		const firstDocument = await firstUpload.json();
		const uploadReplay = await upload(secondApi, "replay.pdf", pdf, key);
		expect(uploadReplay.status()).toBe(200);
		expect((await uploadReplay.json()).id).toBe(firstDocument.id);
		expect((await upload(secondApi, "replay.pdf", scan, key)).status()).toBe(
			409,
		);
		const other = await upload(secondApi, "second.pdf", scan);
		expect(other.status()).toBe(201);
		const secondDocument = await other.json();
		const candidatePaths = [firstDocument, secondDocument].map(
			(document) => `${secondApi}/candidates/${document.candidateId}`,
		);
		for (const path of candidatePaths) {
			const response = await hr.request.patch(path, {
				headers: write,
				data: {
					revision: 0,
					name: "Independent Synthetic",
					email: " FIXTURE@EXAMPLE.TEST ",
					years: 4.5,
				},
			});
			expect(response.status()).toBe(200);
		}
		const stale = await hr.request.patch(candidatePaths[0], {
			headers: write,
			data: { revision: 0, name: "Stale write" },
		});
		expect(stale.status()).toBe(409);
		expect((await stale.json()).current.name).toBe("Independent Synthetic");
		const confirms = await Promise.all(
			candidatePaths.map((path) =>
				hr.request.post(`${path}/confirm`, {
					headers: write,
					data: { revision: 1 },
				}),
			),
		);
		expect(confirms.map((response) => response.status()).sort()).toEqual([
			200, 409,
		]);
		const conflict = confirms.find((response) => response.status() === 409);
		if (!conflict) throw new Error("Missing candidate conflict");
		expect((await conflict.json()).error).toBe("duplicate_email");
		const crossed = await hr.request.get(
			`${api}/documents?ids=${firstDocument.id}`,
		);
		expect(crossed.status()).toBe(404);

		const initial = await upload(
			secondApi,
			"initial.pdf",
			pdf,
			randomUUID(),
			media,
			0,
		);
		expect(initial.status()).toBe(201);
		const initialDoc = await initial.json();
		const badReplacement = await upload(
			secondApi,
			"wrong.pdf",
			Buffer.from("invalid"),
			randomUUID(),
			media,
			1,
		);
		expect(badReplacement.status()).toBe(415);
		expect(
			(
				await hr.request.get(`${secondApi}/documents/${initialDoc.id}/original`)
			).status(),
		).toBe(200);
		const replacements = await Promise.all([
			upload(secondApi, "replacement.pdf", pdf, randomUUID(), media, 1),
			upload(
				secondApi,
				"replacement.docx",
				await readFile(fixturePath("text-resume.docx")),
				randomUUID(),
				docx,
				1,
			),
		]);
		expect(replacements.map((response) => response.status()).sort()).toEqual([
			201, 409,
		]);
		const winning = await replacements
			.find((response) => response.ok())
			?.json();
		expect(
			(
				await hr.request.get(`${secondApi}/documents/${winning.id}/original`)
			).status(),
		).toBe(200);
		expect(
			(
				await hr.request.get(`${secondApi}/documents/${initialDoc.id}/original`)
			).status(),
		).toBe(404);

		// Let the server accept the original, then drop the first response before HR sees it.
		await hr.goto(`/staff/drives/${second.id}`);
		await expect(
			hr.getByRole("heading", { name: "Independent candidacies" }),
		).toBeVisible();
		const loseResponse = `**${secondApi}/documents?kind=resume`;
		await hr.route(
			loseResponse,
			async (route) => {
				const accepted = await route.fetch();
				expect(accepted.status()).toBe(201);
				await route.abort();
			},
			{ times: 1 },
		);
		await hr.getByLabel("Choose resumes").setInputFiles({
			name: "lost-response.pdf",
			mimeType: media,
			buffer: pdf,
		});
		await hr.getByRole("button", { name: "Retry upload" }).click();
		await expect(
			hr.getByRole("button", { name: "Review lost-response.pdf" }),
		).toBeVisible();
		const afterReplay = await (
			await hr.request.get(`${secondApi}/documents`)
		).json();
		expect(
			afterReplay.items.filter(
				(row: { filename: string }) => row.filename === "lost-response.pdf",
			),
		).toHaveLength(1);

		if (process.env.STUDIO_TEST_COMPOSE_PROJECT) {
			await checkIntakeRecovery(
				process.env.STUDIO_TEST_COMPOSE_PROJECT,
				hr,
				origin,
				pdf,
			);
		}
		expect(
			(
				await director.request.patch(`/api/staff/access/${identity.id}`, {
					headers: write,
					data: { role: "director" },
				})
			).status(),
		).toBe(200);
		expect((await hr.request.get(`${api}/documents`)).status()).toBe(403);
		expect((await hr.request.get(api)).status()).toBe(200);
	} finally {
		await Promise.allSettled(contexts.map((context) => context.close()));
	}
});
