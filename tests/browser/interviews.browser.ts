import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { type APIRequestContext, expect, test } from "@playwright/test";

const password = process.env.STUDIO_TEST_INTERVIEW_PASSWORD;
const inbox = process.env.STUDIO_TEST_MAILPIT_URL;
const seededDrive = "00000000-0000-4000-8400-000000000011";

test.skip(
	!password || !inbox,
	"Seed synthetic interview accounts in an isolated Compose project",
);

async function mailCode(request: APIRequestContext, email: string) {
	let code: string | undefined;
	await expect
		.poll(async () => {
			const search = new URL("/api/v1/search", inbox);
			search.searchParams.set("query", `to:${email}`);
			const response = await request.get(search.href);
			if (!response.ok()) return false;
			const { messages } = await response.json();
			const item = messages?.find(
				(message: { Subject: string }) =>
					message.Subject === "Your Interview Studio code",
			);
			if (!item) return false;
			const message = await request.get(
				new URL(`/api/v1/message/${item.ID}`, inbox).href,
			);
			const { Text } = await message.json();
			code = Text.match(/\b\d{6}\b/)?.[0];
			return Boolean(code);
		})
		.toBe(true);
	if (!code) throw new Error("Candidate code missing from Mailpit");
	return code;
}

test("books a confirmed intake candidate and ends their live round across isolated browsers", async ({
	browser,
	baseURL,
}, info) => {
	if (!baseURL || !password)
		throw new Error("Missing local fixture configuration");
	test.setTimeout(65_000);
	const hrContext = await browser.newContext({
		baseURL,
		permissions: ["clipboard-read", "clipboard-write"],
	});
	const assignedContext = await browser.newContext({ baseURL });
	const otherContext = await browser.newContext({ baseURL });
	const candidateContext = await browser.newContext({
		baseURL,
		viewport: { width: 390, height: 844 },
	});
	const write = { origin: baseURL };
	const suffix = randomUUID().slice(0, 8);
	const applicant = "Riley Chen";
	const email = `riley-${suffix}@example.test`;
	const driveRoute = `/staff/drives/${seededDrive}`;

	try {
		const [hr, panelist, candidate] = await Promise.all([
			hrContext.newPage(),
			assignedContext.newPage(),
			candidateContext.newPage(),
		]);
		expect(
			(
				await hr.request.post("/api/auth/sign-in/email", {
					headers: write,
					data: { email: "slice4-hr@studio.test", password },
				})
			).status(),
		).toBe(200);
		const original = await hr.request.get("/api/staff/settings/interviews");
		expect(original.status()).toBe(200);
		expect(await original.json()).toMatchObject({
			timeZone: "Asia/Kolkata",
			duration: 60,
		});

		await hr.goto(driveRoute);
		const filename = `intake-${suffix}.pdf`;
		await hr.getByLabel("Choose resumes").setInputFiles({
			name: filename,
			mimeType: "application/pdf",
			buffer: await readFile(
				fileURLToPath(
					new URL("../fixtures/intake/text-resume.pdf", import.meta.url),
				),
			),
		});
		const row = hr.getByRole("button", { name: `Review ${filename}` });
		await expect(row).toBeVisible({ timeout: 10_000 });
		let draftId: string | undefined;
		await expect
			.poll(async () => {
				const response = await hr.request.get(
					`/api${driveRoute}/review-queue?search=${filename}`,
				);
				const { items } = await response.json();
				draftId = items?.find(
					(item: { document: { filename: string } }) =>
						item.document.filename === filename,
				)?.candidate?.id;
				return Boolean(draftId);
			})
			.toBe(true);

		await hr.getByRole("link", { name: "Interviews", exact: true }).click();
		const search = hr.getByRole("searchbox", { name: "Candidate" });
		await expect(hr.getByTestId("interview-list")).toBeVisible();
		await search.fill(email);
		await expect(hr.getByText("No matches", { exact: true })).toBeVisible();
		const intake = `/api${driveRoute}/candidates/${draftId}`;
		expect(
			(
				await hr.request.patch(intake, {
					headers: write,
					data: { revision: 0, name: applicant, email, years: 4.5 },
				})
			).status(),
		).toBe(200);
		expect(
			(
				await hr.request.post(`${intake}/confirm`, {
					headers: write,
					data: { revision: 1 },
				})
			).status(),
		).toBe(200);
		await hr.reload();
		await expect(search).toHaveValue(email);
		const schedule = hr.getByRole("button", {
			name: `Schedule L1 for ${applicant}`,
		});
		await expect(schedule).toBeVisible();
		await expect(hr.getByTestId("interview-list")).toContainText(
			"Platform Engineering",
		);
		await hr.route("**/api/staff/interviews?*", async (route) => {
			const response = await route.fetch();
			await new Promise((resolve) => setTimeout(resolve, 350));
			await route.fulfill({ response });
		});
		await search.fill(`riley-${suffix.slice(0, 4)}`);
		await expect(search).toBeFocused();
		await expect(schedule).toBeVisible();
		await expect(schedule).toBeEnabled();
		await expect(search).toBeFocused();
		await hr.unroute("**/api/staff/interviews?*");

		await hr.setViewportSize({ width: 390, height: 844 });
		await schedule.press("Enter");
		let sheet = hr.getByRole("dialog");
		await expect(
			sheet.getByRole("heading", { name: "Schedule L1" }),
		).toBeVisible();
		await expect(sheet.getByLabel("Duration (minutes)")).toHaveValue("60");
		await sheet.getByRole("button", { name: "Close", exact: true }).click();
		await expect(schedule).toBeFocused();
		await schedule.press("Enter");
		const chooser = sheet.getByRole("combobox", { name: "Panelist" });
		await chooser.fill("slice4-panelist");
		await expect(
			hr.getByRole("option", { name: /slice4-panelist@studio.test/ }),
		).toBeVisible();
		await chooser.press("ArrowDown");
		await chooser.press("Enter");
		await expect(
			sheet.getByText("slice4-panelist@studio.test", { exact: true }),
		).toBeVisible();
		const local = new Date(Date.now() + (330 + 2) * 60_000).toISOString();
		await sheet.getByLabel("Date", { exact: true }).fill(local.slice(0, 10));
		await sheet.getByLabel("Start time").fill(local.slice(11, 16));
		await sheet.getByLabel("Duration (minutes)").fill("45");
		await expect(sheet.getByRole("status")).toContainText("Asia/Kolkata");
		const primary = sheet.getByRole("button", { name: "Book interview" });
		await expect(primary).toBeInViewport();
		expect((await sheet.boundingBox())?.width).toBe(390);
		if (process.env.STUDIO_TEST_INTERVIEW_SCREENSHOTS)
			await hr.screenshot({
				path: info.outputPath("hr-booking-mobile.png"),
				animations: "disabled",
			});
		await primary.click();
		await expect(
			sheet.getByRole("button", { name: "Copy Studio link" }),
		).toBeVisible();
		await expect(sheet.getByText("Teams link pending")).toBeVisible();
		await sheet.getByRole("button", { name: "Copy Studio link" }).click();
		await expect(sheet.getByRole("status")).toContainText("Studio link copied");
		const link = new URL(
			await hr.evaluate(() => navigator.clipboard.readText()),
		);
		expect(link.hash.length).toBe(44);
		const pageURL = new URL(hr.url());
		const id = pageURL.searchParams.get("booking");
		expect(id).toBeTruthy();
		await hr.reload();
		sheet = hr.getByRole("dialog");
		await sheet
			.getByRole("button", { name: "Copy invitation", exact: true })
			.click();
		await expect(sheet.getByRole("status")).toContainText("Invitation copied");
		const inviteText = await hr.evaluate(() => navigator.clipboard.readText());
		expect(inviteText).toContain(link.href);
		expect(inviteText).toContain("Teams link pending");
		await sheet.getByRole("button", { name: "Edit meeting details" }).click();
		const teamsField = sheet.getByLabel("Teams URL (optional)");
		await teamsField.fill("https://teams.example.test/join");
		const concurrentMeeting = await hr.request.post(
			`/api/staff/interviews/${id}/commands`,
			{
				headers: write,
				data: {
					action: "meeting",
					commandId: randomUUID(),
					revision: 0,
					meeting: {
						mode: "virtual",
						teamsUrl: "https://teams.example.test/updated-by-hr",
					},
				},
			},
		);
		expect(concurrentMeeting.status()).toBe(200);
		const saveMeeting = sheet.getByRole("button", {
			name: "Save meeting details",
		});
		await saveMeeting.click();
		await expect(
			sheet.getByText("https://teams.example.test/updated-by-hr", {
				exact: true,
			}),
		).toBeVisible();
		await expect(saveMeeting).toBeDisabled();
		await expect(teamsField).toHaveValue("https://teams.example.test/join");
		await sheet
			.getByRole("button", { name: "Continue with my changes" })
			.click();
		await saveMeeting.click();
		await expect(
			sheet.getByRole("link", { name: "Open Teams meeting" }),
		).toBeVisible();

		const fromInvitation = inviteText.match(/https?:\/\/\S+\/join\/\S+/)?.[0];
		if (!fromInvitation)
			throw new Error("Copied invitation did not contain the join link");
		await panelist.goto(fromInvitation);
		await panelist.getByRole("link", { name: "Staff sign-in" }).click();
		await expect(panelist).toHaveURL(/\/sign-in\?invitationId=/);
		await panelist.getByLabel("Work email").fill("slice4-panelist@studio.test");
		await panelist.getByLabel("Password", { exact: true }).fill(password);
		await panelist
			.getByRole("button", { name: "Sign in", exact: true })
			.click();
		await expect(panelist).toHaveURL(new RegExp(`/staff/my-interviews/${id}$`));
		await expect(
			panelist.getByRole("heading", { name: applicant }),
		).toBeVisible();
		await expect(
			panelist.getByRole("button", { name: "Start interview" }),
		).toBeDisabled();
		expect(
			(
				await otherContext.request.post("/api/auth/sign-in/email", {
					headers: write,
					data: { email: "slice4-other@studio.test", password },
				})
			).status(),
		).toBe(200);
		expect(
			(
				await otherContext.request.get(`/api/staff/my-interviews/${id}`)
			).status(),
		).toBe(404);
		expect(
			(await otherContext.request.get("/api/staff/interviews")).status(),
		).toBe(403);

		await candidate.goto(fromInvitation);
		await expect(candidate).toHaveURL(link.origin + link.pathname);
		await expect(candidate.getByText(applicant)).toHaveCount(0);
		expect(
			(await candidate.request.get(`/api/interviews/rounds/${id}`)).status(),
		).toBe(401);
		await candidate.getByRole("button", { name: "Join as candidate" }).click();
		await candidate.getByLabel("Invited email").fill("wrong@example.test");
		await candidate.getByRole("button", { name: "Send code" }).click();
		await expect(candidate.getByRole("alert")).toContainText(
			"invitation is unavailable",
		);
		await candidate.route(
			"**/api/interviews/invitations/*/code",
			async (route) => {
				const response = await route.fetch();
				await new Promise((resolve) => setTimeout(resolve, 350));
				await route.fulfill({ response });
			},
		);
		const invitedEmail = candidate.getByLabel("Invited email");
		await invitedEmail.fill(email);
		await candidate.getByRole("button", { name: "Send code" }).click();
		await expect(invitedEmail).toBeDisabled();

		const verification = candidate.getByLabel("Verification code");
		await expect(verification).toBeFocused();
		await verification.fill(await mailCode(candidate.request, email));
		await candidate.getByRole("button", { name: "Verify code" }).click();
		await expect(
			candidate.getByRole("heading", { name: "Confirm your details" }),
		).toBeVisible();
		await expect(candidate.getByLabel("Full name")).toHaveValue(applicant);
		await candidate.getByLabel("Years of experience").fill("5");
		await candidate.getByRole("button", { name: "Confirm and join" }).click();
		await expect(
			candidate.getByRole("heading", { name: "You’re in the waiting room" }),
		).toBeVisible();
		expect((await candidate.request.get("/api/staff/me")).status()).toBe(401);
		if (process.env.STUDIO_TEST_INTERVIEW_SCREENSHOTS)
			await candidate.screenshot({
				path: info.outputPath("candidate-waiting-room.png"),
				animations: "disabled",
			});

		const start = panelist.getByRole("button", { name: "Start interview" });
		await expect(start).toBeEnabled({ timeout: 12_000 });
		await expect(panelist.getByText(/5 years of experience/)).toBeVisible();
		if (process.env.STUDIO_TEST_INTERVIEW_SCREENSHOTS)
			await panelist.screenshot({
				path: info.outputPath("panelist-ready.png"),
				animations: "disabled",
			});
		await start.click();
		await expect(
			candidate.getByRole("heading", { name: "Interview in progress" }),
		).toBeVisible({ timeout: 12_000 });
		await candidate.reload();
		await expect(
			candidate.getByRole("heading", { name: "Interview in progress" }),
		).toBeVisible();
		await candidate.getByRole("button", { name: "End interview" }).click();
		await candidate
			.getByRole("dialog")
			.getByRole("button", { name: "End interview", exact: true })
			.click();
		await expect(
			candidate.getByRole("heading", {
				name: "Interview ended or unavailable",
			}),
		).toBeVisible();
		expect(
			(await candidate.request.get(`/api/interviews/rounds/${id}`)).status(),
		).toBe(404);
		await expect(
			panelist.getByText("Awaiting feedback", { exact: true }),
		).toBeVisible({ timeout: 12_000 });
		await sheet.getByRole("button", { name: "Refresh details" }).click();
		await expect(
			sheet.getByText("Awaiting feedback", { exact: true }),
		).toBeVisible();
		if (process.env.STUDIO_TEST_INTERVIEW_SCREENSHOTS)
			await hr.screenshot({
				path: info.outputPath("hr-awaiting-feedback.png"),
				animations: "disabled",
			});

		await hr.goto("/staff/settings");
		const defaultDuration = hr.getByLabel("Default duration (minutes)");
		await expect(defaultDuration).toHaveValue("60");
		await defaultDuration.fill("75");
		await hr.getByRole("button", { name: "Save preferences" }).click();
		await expect(hr.getByRole("status")).toContainText(
			"Scheduling preferences saved.",
		);
		const bookable = hr.getByRole("button", {
			name: "Schedule L1 for Avery Morgan",
			exact: true,
		});
		await hr.goto("/staff/interviews");
		await bookable.click();
		await expect(
			hr.getByRole("dialog").getByLabel("Duration (minutes)"),
		).toHaveValue("75");
		const savedRound = await hr.request.get(`/api/staff/interviews/${id}`);
		expect(await savedRound.json()).toMatchObject({
			duration: 45,
			timeZone: "Asia/Kolkata",
		});

		await hr.goto("/staff/settings");
		await expect(defaultDuration).toHaveValue("75");
		await defaultDuration.fill("60");
		await hr.getByRole("button", { name: "Save preferences" }).click();
		await expect(hr.getByRole("status")).toContainText(
			"Scheduling preferences saved.",
		);
	} finally {
		await Promise.allSettled([
			hrContext.close(),
			assignedContext.close(),
			otherContext.close(),
			candidateContext.close(),
		]);
	}
});

test("reuses tab data, invalidates it after booking, and preserves the mobile conflict override", async ({
	page,
	baseURL,
}, info) => {
	if (!baseURL || !password)
		throw new Error("Missing local fixture configuration");
	expect(
		(
			await page.request.post("/api/auth/sign-in/email", {
				headers: { origin: baseURL },
				data: { email: "slice4-hr@studio.test", password },
			})
		).status(),
	).toBe(200);
	const result = await page.request.get(
		"/api/staff/interviews?tab=scheduled&search=Avery%20M.%20Morgan",
	);
	expect(result.status()).toBe(200);
	const { items } = await result.json();
	expect(items).toHaveLength(1);
	const start = new Date(
		Date.parse(items[0].start) + 330 * 60_000,
	).toISOString();
	const listReads: string[] = [];
	page.on("request", (request) => {
		const url = new URL(request.url());
		if (request.method() === "GET" && url.pathname === "/api/staff/interviews")
			listReads.push(url.searchParams.get("tab") ?? "queue");
	});
	if (process.env.STUDIO_TEST_INTERVIEW_SCREENSHOTS) {
		await page.addInitScript(() =>
			localStorage.setItem("interview-studio-theme", "dark"),
		);
	}
	await page.goto("/staff/interviews");
	const tabs = ["To schedule", "Scheduled", "History"];
	for (const name of tabs) {
		await page.getByRole("tab", { name, exact: true }).click();
		await expect(
			page.getByRole("tabpanel", { name, exact: true }),
		).toHaveAttribute("aria-busy", "false");
	}
	expect(listReads).toEqual(["queue", "scheduled", "history"]);
	if (process.env.STUDIO_TEST_INTERVIEW_SCREENSHOTS) {
		await page.getByRole("tab", { name: "Scheduled", exact: true }).click();
		await page
			.getByRole("button", {
				name: "View booking for Avery M. Morgan",
				exact: true,
			})
			.click();
		const detail = page.getByRole("dialog");
		await expect(
			detail.getByRole("heading", { name: "Avery M. Morgan" }),
		).toBeVisible();
		await page.screenshot({
			path: info.outputPath("redesigned-booking-detail.png"),
			animations: "disabled",
		});
		await detail.getByRole("button", { name: "Manage booking" }).click();
		await page.getByRole("menuitem", { name: "Reassign panelist" }).click();
		await expect(
			detail.getByRole("heading", { name: "Reassign panelist" }),
		).toBeVisible();
		await detail.getByRole("button", { name: "Back to booking" }).click();
		await detail.getByRole("button", { name: "Close", exact: true }).click();
	}
	for (const name of [...tabs, tabs[0]]) {
		await page.getByRole("tab", { name, exact: true }).click();
		await expect(
			page.getByRole("tabpanel", { name, exact: true }),
		).toHaveAttribute("aria-busy", "false");
	}
	expect(listReads).toEqual(["queue", "scheduled", "history"]);
	await page.getByRole("button", { name: "Experience", exact: true }).click();
	await page.getByLabel("Minimum years").fill("6");
	await page.getByRole("button", { name: "Apply experience" }).click();
	await expect(
		page.getByRole("button", { name: "Experience, 6+ years", exact: true }),
	).toBeFocused();
	await expect(page.getByText("No matches", { exact: true })).toBeVisible();
	await page.getByRole("button", { name: "Clear filters" }).click();
	if (process.env.STUDIO_TEST_INTERVIEW_SCREENSHOTS) {
		await expect(page.getByTestId("interview-list")).toContainText(
			"Avery Morgan",
		);
		await page.screenshot({
			path: info.outputPath("redesigned-interviews.png"),
			animations: "disabled",
		});
	}
	await page.setViewportSize({ width: 390, height: 844 });
	const opener = page.getByRole("button", {
		name: "Schedule L1 for Avery Morgan",
		exact: true,
	});
	await opener.click();
	const sheet = page.getByRole("dialog");
	await sheet.getByRole("combobox", { name: "Panelist" }).fill("slice4-other");
	await page.getByRole("option", { name: /slice4-other@studio.test/ }).click();
	const date = sheet.getByLabel("Date", { exact: true });
	const time = sheet.getByLabel("Start time");
	await date.fill(start.slice(0, 10));
	await time.fill(start.slice(11, 16));
	await sheet.getByRole("button", { name: "Book interview" }).click();
	await expect(sheet.getByRole("alert")).toContainText(
		"Candidate · Infrastructure Hiring",
	);
	await expect(sheet.getByRole("alert")).toBeInViewport();
	await expect(
		sheet.getByRole("button", { name: "Book anyway" }),
	).toBeInViewport();
	await expect(date).toHaveValue(start.slice(0, 10));
	await expect(time).toHaveValue(start.slice(11, 16));
	if (process.env.STUDIO_TEST_INTERVIEW_SCREENSHOTS)
		await page.screenshot({
			path: info.outputPath("booking-conflict-mobile.png"),
			animations: "disabled",
		});
	await sheet.getByRole("button", { name: "Close", exact: true }).click();
	await expect(opener).toBeFocused();

	await opener.click();
	await sheet.getByRole("combobox", { name: "Panelist" }).fill("slice4-other");
	await page.getByRole("option", { name: /slice4-other@studio.test/ }).click();
	await date.fill(start.slice(0, 10));
	await time.fill(start.slice(11, 16));
	const queue = await page.request.get(
		`/api/staff/interviews?tab=queue&driveId=${seededDrive}&search=Avery%20Morgan`,
	);
	expect(queue.ok()).toBe(true);
	const [candidate] = (await queue.json()).items;
	const update = await page.request.patch(
		`/api/staff/drives/${seededDrive}/candidates/${candidate.id}`,
		{
			headers: { origin: baseURL },
			data: { revision: candidate.revision, years: 6.5 },
		},
	);
	expect(update.ok()).toBe(true);
	await sheet.getByRole("button", { name: "Book interview" }).click();
	await expect(sheet.getByRole("alert")).toContainText("This record changed.");
	await expect(sheet.getByText("6.5 years of experience")).toBeVisible();
	await expect(date).toHaveValue(start.slice(0, 10));
	await expect(time).toHaveValue(start.slice(11, 16));
	await sheet.getByRole("button", { name: "Book interview" }).click();
	await expect(sheet.getByRole("alert")).toContainText(
		"Candidate · Infrastructure Hiring",
	);

	let recoveredId: string | undefined;
	const approvedBodies: object[] = [];
	const delayedFailure = Promise.withResolvers<void>();
	const delayedSuccess = Promise.withResolvers<void>();
	await page.route("**/api/staff/interviews", async (route) => {
		if (route.request().method() !== "POST") return route.continue();
		approvedBodies.push(route.request().postDataJSON());
		const response = await route.fetch();
		if (approvedBodies.length === 1 && response.ok()) {
			recoveredId = (await response.json()).id;
			await delayedFailure.promise;
			await route.abort("failed");
		} else {
			await delayedSuccess.promise;
			await route.fulfill({ response });
		}
	});
	try {
		const override = sheet.getByRole("button", { name: "Book anyway" });
		const close = sheet.getByRole("button", { name: "Close", exact: true });
		const queueUrl = page.url();
		await override.click();
		await expect(close).toBeDisabled();
		await page.keyboard.press("Escape");
		await page.evaluate(() => history.back());
		await expect(page).toHaveURL(queueUrl);
		await expect(
			sheet.getByRole("heading", { name: "Schedule L1" }),
		).toBeVisible();
		delayedFailure.resolve();
		await expect(
			sheet.getByText("Couldn’t reach Interview Studio. Try again."),
		).toBeVisible();
		await expect(close).toBeEnabled();
		await expect(date).toHaveValue(start.slice(0, 10));
		await expect(time).toHaveValue(start.slice(11, 16));
		await override.click();
		await expect(close).toBeDisabled();
		await page.keyboard.press("Escape");
		await expect(
			sheet.getByRole("heading", { name: "Schedule L1" }),
		).toBeVisible();
		delayedSuccess.resolve();
		await expect(
			sheet.getByRole("button", { name: "Copy Studio link" }),
		).toBeVisible();
		expect(recoveredId).toBeTruthy();
		expect(new URL(page.url()).searchParams.get("booking")).toBe(recoveredId);
		expect(approvedBodies).toHaveLength(2);
		expect(approvedBodies[0]).toMatchObject({
			candidateRevision: candidate.revision + 1,
		});
		expect(approvedBodies[0]).toEqual(approvedBodies[1]);
		await sheet.getByRole("button", { name: "Close", exact: true }).click();
		await expect(
			page.getByRole("button", {
				name: "View booking for Avery Morgan",
				exact: true,
			}),
		).toBeVisible();
		await page.getByRole("tab", { name: "To schedule", exact: true }).click();
		await expect(
			page.getByRole("tabpanel", { name: "To schedule" }),
		).toHaveAttribute("aria-busy", "false");
		await expect(opener).toHaveCount(0);
	} finally {
		delayedFailure.resolve();
		delayedSuccess.resolve();
		await page.unroute("**/api/staff/interviews");
		if (recoveredId) {
			const response = await page.request.post(
				`/api/staff/interviews/${recoveredId}/commands`,
				{
					headers: { origin: baseURL },
					data: { action: "cancel", commandId: randomUUID(), revision: 0 },
				},
			);
			expect(response.status()).toBe(200);
		}
	}
});
