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

async function mailCode(
	request: APIRequestContext,
	email: string,
	expectedMessages = 1,
) {
	let code: string | undefined;
	await expect
		.poll(async () => {
			const search = new URL("/api/v1/search", inbox);
			search.searchParams.set("query", `to:${email}`);
			const response = await request.get(search.href);
			if (!response.ok()) return false;
			const { messages } = await response.json();
			const matching = messages?.filter(
				(message: { Subject: string }) =>
					message.Subject === "Your Interview Studio code",
			);
			if (!matching || matching.length < expectedMessages) return false;
			const [item] = matching.sort(
				(first: { Created: string }, second: { Created: string }) =>
					second.Created.localeCompare(first.Created),
			);
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

test("takes a candidate through both rounds and resolves a corrected hiring decision", async ({
	browser,
	baseURL,
}, info) => {
	if (!baseURL || !password)
		throw new Error("Missing local fixture configuration");
	test.setTimeout(240_000);
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

		await test.step("saves and reviews a full set of escaped Unicode skill names", async () => {
			const drive = "00000000-0000-4000-8400-000000000012";
			const path = `/api/staff/drives/${drive}/skills/l2`;
			const skills = Array.from({ length: 50 }, (_, index) => ({
				name: `技`.repeat(118) + String(index).padStart(2, "0"),
			}));
			const escaped = JSON.stringify({ revision: 1, skills }).replaceAll(
				"技",
				"\\u6280",
			);
			const save = await hr.request.put(path, {
				headers: { ...write, "content-type": "application/json" },
				data: escaped,
			});
			expect(save.status()).toBe(200);
			const { revision } = await save.json();
			const review = await hr.request.post(`${path}/review`, {
				headers: write,
				data: { revision },
			});
			expect(review.status()).toBe(200);
			expect(await review.json()).toMatchObject({
				reviewedAt: expect.any(String),
				skills,
			});
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
		const shortSearch = `riley-${suffix.slice(0, 4)}`;
		const isShortSearch = (url: URL) =>
			url.pathname === "/api/staff/interviews/workspace" &&
			url.searchParams.get("search") === shortSearch;
		const delayedSearch = hr.waitForResponse((response) =>
			isShortSearch(new URL(response.url())),
		);
		await hr.route(
			isShortSearch,
			async (route) => {
				await new Promise((resolve) => setTimeout(resolve, 350));
				await route.continue();
			},
			{ times: 1 },
		);
		await search.fill(shortSearch);
		await expect(search).toBeFocused();
		await expect(schedule).toBeVisible();
		await expect(schedule).toBeEnabled();
		await expect(search).toBeFocused();
		await delayedSearch;

		await hr.setViewportSize({ width: 320, height: 700 });
		const firstTab = hr.getByRole("tab", { name: "Action needed" });
		const lastTab = hr.getByRole("tab", { name: "History" });
		await expect(firstTab).toBeInViewport({ ratio: 1 });
		await expect(lastTab).toBeInViewport({ ratio: 1 });
		await expect
			.poll(() =>
				lastTab.evaluate((tab) => {
					const { left, top, width, height } = tab.getBoundingClientRect();
					return tab.contains(
						document.elementFromPoint(left + width / 2, top + height / 2),
					);
				}),
			)
			.toBe(true);
		if (process.env.STUDIO_TEST_INTERVIEW_SCREENSHOTS)
			await hr.screenshot({
				path: info.outputPath("hr-tabs-320.png"),
				animations: "disabled",
			});
		await hr.setViewportSize({ width: 390, height: 844 });
		await schedule.press("Enter");
		let sheet = hr.getByRole("dialog");
		await expect(
			sheet.getByRole("heading", { name: "Schedule L1" }),
		).toBeVisible();
		await expect(sheet.getByLabel("Duration (minutes)")).toHaveValue("60");
		await sheet.getByRole("button", { name: "Close", exact: true }).click();
		await expect(schedule).toBeFocused();
		await hr.goto("/staff");
		const dashboardActions = hr.getByRole("region", { name: "Action needed" });
		const dashboardSchedule = dashboardActions.getByRole("button", {
			name: `Schedule L1 for ${applicant}`,
		});
		await expect(dashboardSchedule).toBeVisible();
		await expect(
			hr.getByRole("region", { name: "Recent outcomes" }),
		).toBeVisible();
		expect(await hr.evaluate(() => document.documentElement.scrollWidth)).toBe(
			390,
		);
		if (process.env.STUDIO_TEST_INTERVIEW_SCREENSHOTS) {
			await hr.screenshot({
				path: info.outputPath("hr-dashboard-mobile.png"),
				animations: "disabled",
			});
			await hr.setViewportSize({ width: 1440, height: 900 });
			await hr.evaluate(() => document.documentElement.classList.add("dark"));
			await hr.screenshot({
				path: info.outputPath("hr-dashboard-desktop-dark.png"),
				animations: "disabled",
			});
			await hr.evaluate(() =>
				document.documentElement.classList.remove("dark"),
			);
			await hr.setViewportSize({ width: 390, height: 844 });
		}
		await dashboardSchedule.press("Enter");
		await expect(
			sheet.getByRole("heading", { name: "Schedule L1" }),
		).toBeVisible();
		await sheet.getByRole("button", { name: "Close", exact: true }).click();
		await expect(dashboardSchedule).toBeFocused();
		await dashboardSchedule.press("Enter");
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
		await expect(hr).toHaveURL(
			(url) =>
				url.searchParams.get("tab") === "scheduled" &&
				url.searchParams.has("booking"),
		);
		await expect(sheet.getByText("Meeting link pending")).toBeVisible();
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
		expect(inviteText).toContain("Meeting link pending");
		await sheet.getByRole("button", { name: "Edit meeting details" }).click();
		const teamsField = sheet.getByLabel("Meeting URL (optional)");
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
			sheet.getByRole("link", { name: "Open meeting at teams.example.test" }),
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
		const panelistHome = await assignedContext.newPage();
		await panelistHome.goto("/staff");
		const attention = panelistHome.getByRole("region", {
			name: "Needs your attention",
		});
		const upcoming = panelistHome.getByRole("region", { name: "Upcoming" });
		await expect(
			upcoming.getByRole("link", { name: `Open interview for ${applicant}` }),
		).toBeVisible();
		await expect(upcoming).toContainText("Asia/Kolkata");
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
		const otherDashboard = await otherContext.request.get(
			"/api/staff/my-interviews/dashboard",
		);
		expect(otherDashboard.ok()).toBe(true);
		expect(await otherDashboard.json()).toMatchObject({
			attention: { items: [] },
			upcoming: { items: [] },
			submitted: { items: [] },
		});

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
				await new Promise((resolve) => setTimeout(resolve, 350));
				await route.continue();
			},
			{ times: 1 },
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
		await expect(
			attention.getByText("Candidate waiting", { exact: true }),
		).toBeVisible({
			timeout: 12_000,
		});
		await expect(upcoming).not.toContainText(applicant);
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
		await expect(
			attention.getByRole("link", {
				name: `Continue interview for ${applicant}`,
			}),
		).toBeVisible({ timeout: 12_000 });
		const candidateWorkspace = candidate.getByRole("region", {
			name: "Interview workspace",
		});
		const panelistWorkspace = panelist.getByRole("region", {
			name: "Interview workspace",
		});
		const candidateSource = candidateWorkspace.getByLabel("Source code");
		const panelistSource = panelistWorkspace.getByLabel("Source code");
		await expect(panelistWorkspace.getByText("Live · Read only")).toBeVisible({
			timeout: 12_000,
		});
		await candidateWorkspace.getByLabel("Language").selectOption("python");
		await expect(candidateSource).toContainText('print("Hello, world!")');
		await candidateSource.fill('print("Studio workspace 😀")');
		await expect(
			candidateWorkspace.getByText("Saved", { exact: true }),
		).toBeVisible();
		await expect(panelistSource).toHaveAttribute("contenteditable", "false");
		await expect(panelistSource).toContainText('print("Studio workspace 😀")', {
			timeout: 12_000,
		});
		await candidate.reload();
		await expect(candidateSource).toContainText('print("Studio workspace 😀")');
		await expect(candidateWorkspace.getByLabel("Language")).toHaveValue(
			"python",
		);
		await candidateWorkspace.getByLabel("Language").selectOption("java");
		await expect(candidateSource).toContainText("public class Main");
		await candidateWorkspace.getByLabel("Language").selectOption("python");
		await expect(candidateSource).toContainText('print("Studio workspace 😀")');

		// Open the heavier canvas only when the user selects Whiteboard.
		await candidate.setViewportSize({ width: 1040, height: 900 });
		const boardTab = candidateWorkspace.getByRole("tab", {
			name: "Whiteboard",
		});
		await boardTab.focus();
		await boardTab.press("Enter");
		const boardPanel = candidateWorkspace.getByRole("tabpanel", {
			name: "Whiteboard",
		});
		const candidateCanvas = boardPanel.locator("canvas.interactive");
		await expect(candidateCanvas).toBeVisible({ timeout: 15_000 });
		await boardPanel.getByTitle(/^Rectangle/).click({ timeout: 8_000 });
		await candidateCanvas.scrollIntoViewIfNeeded();
		const board = await candidateCanvas.boundingBox();
		if (!board) throw new Error("Canvas is missing its drawing area");
		const drawStart = {
			x: board.x + board.width * 0.44,
			y: board.y + board.height * 0.41,
		};
		await candidate.mouse.move(drawStart.x, drawStart.y);
		await candidate.mouse.down();
		await candidate.mouse.move(drawStart.x + 135, drawStart.y + 65, {
			steps: 8,
		});
		await candidate.mouse.up();
		await boardPanel.getByTitle(/^Draw/).click({ timeout: 8_000 });
		await candidateCanvas.scrollIntoViewIfNeeded();
		const penStart = {
			x: board.x + board.width * 0.23,
			y: board.y + board.height * 0.6,
		};
		await candidate.mouse.move(penStart.x, penStart.y);
		await candidate.mouse.down();
		await candidate.mouse.move(penStart.x + 62, penStart.y + 35, { steps: 7 });
		await candidate.mouse.move(penStart.x + 100, penStart.y + 5, { steps: 4 });
		await candidate.mouse.up();
		await boardPanel.getByTitle(/^Text/).click({ timeout: 8_000 });
		await candidateCanvas.click({
			position: { x: board.width * 0.49, y: board.height * 0.72 },
		});
		const boardText = boardPanel.locator("textarea");
		await boardText.fill("Synthetic canvas note", { timeout: 8_000 });
		await boardText.press("Escape");
		await expect(
			candidateWorkspace.getByText("Saved", { exact: true }),
		).toBeVisible();
		await panelistWorkspace.getByRole("tab", { name: "Whiteboard" }).click();
		await panelistWorkspace
			.getByText("Scene summary · 3 elements")
			.click({ timeout: 12_000 });
		await expect(
			panelistWorkspace.getByText("Synthetic canvas note", { exact: true }),
		).toBeVisible();
		const expand = panelistWorkspace.getByRole("button", {
			name: "Full screen",
			exact: true,
		});
		await expand.click();
		const fullscreen = panelist.getByRole("dialog", {
			name: "Interview workspace",
		});
		await fullscreen.getByRole("region", { name: "Drawing canvas" }).click();
		await panelist.keyboard.press("Escape");
		await expect(
			fullscreen.getByRole("button", { name: "Center drawing" }),
		).toBeFocused();
		await panelist.keyboard.press("Escape");
		await expect(expand).toBeFocused();
		await candidate.reload();
		await candidateWorkspace.getByRole("tab", { name: "Whiteboard" }).click();
		await expect(candidateCanvas).toBeVisible();
		const candidateDescriptor = await candidate.request.get(
			`/api/interviews/rounds/${id}/workspace`,
		);
		const { binding } = await candidateDescriptor.json();
		const boardHead = await candidate.request.get(
			`/api/interviews/rounds/${id}/workspace/board`,
			{
				headers: { "X-Studio-Workspace": binding },
			},
		);
		expect(
			(await boardHead.json()).payload.elements.map(
				(element: { type: string }) => element.type,
			),
		).toEqual(["rectangle", "freedraw", "text"]);
		await panelistWorkspace.getByRole("tab", { name: "Code" }).click();
		await candidate.setViewportSize({ width: 390, height: 844 });

		const assessmentPath = `/api/staff/my-interviews/${id}/assessment`;
		await panelist.setViewportSize({ width: 390, height: 844 });
		await expect(
			panelist.getByText("0 of 2 rated", { exact: true }),
		).toBeVisible();
		const notes = panelist.getByLabel("Private notes", { exact: true });
		const privateNotes = "🧭".repeat(16_000);
		await notes.fill(privateNotes);
		await panelist.getByText("Private observations", { exact: true }).click();
		await panelist
			.getByLabel("Context", { exact: true })
			.fill("During the canvas exercise");
		await panelist
			.getByLabel("Observation", { exact: true })
			.fill("Synthetic observation for the assigned panelist");
		await panelist.getByRole("button", { name: "Save observation" }).click();
		await expect(
			panelist.getByText("Observation saved.", { exact: true }),
		).toBeVisible();
		await expect(notes).toHaveValue(privateNotes);
		const concernPath = `/api/staff/my-interviews/${id}/concerns`;
		expect((await otherContext.request.get(concernPath)).status()).toBe(404);
		expect((await hr.request.get(concernPath)).status()).toBe(403);
		expect((await candidate.request.get(concernPath)).status()).toBe(401);
		await panelist
			.getByText("Private observations (1)", { exact: true })
			.click();

		const addQuestion = panelist.getByRole("button", { name: "Add question" });
		await addQuestion.press("Enter");
		const question = panelist.getByLabel("Question 1", { exact: true });
		await expect(question).toBeFocused();
		await question.fill("What did you measure in production?");
		await panelist
			.getByLabel("Technical reasoning", { exact: true })
			.selectOption("exceeds_expectations");
		await panelist
			.getByLabel("Communication", { exact: true })
			.selectOption("not_assessed");
		await expect(
			panelist.getByText("2 of 2 rated", { exact: true }),
		).toBeVisible();
		const skillFeedback = panelist.getByLabel(
			"Feedback for Technical reasoning",
			{
				exact: true,
			},
		);
		await expect(skillFeedback).toBeHidden();
		await panelist
			.getByRole("button", {
				name: "Add feedback for Technical reasoning",
			})
			.click();
		await skillFeedback.fill("Explained the trade-offs clearly.");
		await panelist
			.getByRole("button", {
				name: "Hide feedback for Technical reasoning",
			})
			.click();
		await expect(skillFeedback).toBeHidden();
		await panelist.getByLabel("Decision", { exact: true }).selectOption("pass");
		await panelist
			.getByLabel("Decision rationale")
			.fill("Validated the approach with production examples.");
		await panelist
			.getByLabel("Technical reasoning", { exact: true })
			.scrollIntoViewIfNeeded();
		await expect(
			panelist.getByRole("button", { name: "Save draft" }),
		).toBeInViewport({ ratio: 1 });
		expect(
			(
				await panelist.request.patch(`${assessmentPath}/draft`, {
					headers: { ...write, connection: "close" },
					data: {
						commandId: randomUUID(),
						draftRevision: 0,
						content: { notes: "x".repeat(1024 * 1024 + 1) },
					},
				})
			).status(),
		).toBe(413);
		await panelist
			.getByRole("main")
			.getByRole("link", { name: "My interviews", exact: true })
			.click();
		const unsaved = panelist.getByRole("dialog", {
			name: "Leave with unsaved changes?",
		});
		await expect(unsaved).toBeVisible();
		await unsaved.getByRole("button", { name: "Keep editing" }).click();
		await expect(panelist.getByLabel("Decision rationale")).toHaveValue(
			"Validated the approach with production examples.",
		);
		await panelist.getByRole("button", { name: "Save draft" }).click();
		await expect(
			panelist.getByText("Draft saved", { exact: true }),
		).toBeVisible();
		await expect(
			panelist.getByRole("button", { name: "Submit feedback" }),
		).toHaveCount(0);
		await panelist.reload();
		await expect(notes).toHaveValue(privateNotes);
		await expect(question).toHaveValue("What did you measure in production?");
		await expect(skillFeedback).toBeVisible();
		await expect(skillFeedback).toHaveValue(
			"Explained the trade-offs clearly.",
		);
		expect(
			await panelist.evaluate(() => document.documentElement.scrollWidth),
		).toBe(390);
		const savedAssessment = await panelist.request.get(assessmentPath, {
			maxRetries: 1,
		});
		const tag = savedAssessment.headers().etag;
		expect(tag).toMatch(/^"[a-f0-9]{64}"$/);
		const conditional = { headers: { "If-None-Match": tag } };
		expect(
			(await panelist.request.get(assessmentPath, conditional)).status(),
		).toBe(304);
		const { draft } = await savedAssessment.json();
		await notes.fill("Keep these local observations.");
		expect(
			(
				await panelist.request.patch(`${assessmentPath}/draft`, {
					headers: write,
					data: {
						commandId: randomUUID(),
						draftRevision: draft.revision,
						content: { ...draft.content, notes: "Saved from another session." },
					},
				})
			).status(),
		).toBe(200);
		await expect(
			panelist.getByText("A newer draft was saved", { exact: true }),
		).toBeVisible({ timeout: 12_000 });
		await panelist
			.getByText("Compare with the saved draft", { exact: true })
			.click();
		await expect(
			panelist.getByText("Saved from another session.", { exact: true }),
		).toBeVisible();
		await expect(notes).toHaveValue("Keep these local observations.");
		expect(
			(await panelist.request.get(assessmentPath, conditional)).status(),
		).toBe(200);
		await panelist.getByRole("button", { name: "Keep my edits" }).click();
		await panelist.getByRole("button", { name: "Save draft" }).click();
		await expect(
			panelist.getByText("Draft saved", { exact: true }),
		).toBeVisible();
		if (process.env.STUDIO_TEST_INTERVIEW_SCREENSHOTS) {
			await panelist
				.getByText("Manual assessment", { exact: true })
				.scrollIntoViewIfNeeded();
			await panelist.screenshot({
				path: info.outputPath("panelist-draft-mobile.png"),
				animations: "disabled",
			});
		}
		expect((await otherContext.request.get(assessmentPath)).status()).toBe(404);
		expect((await candidate.request.get(assessmentPath)).status()).toBe(401);
		expect(
			(await hr.request.get(`/api/staff/interviews/${id}/assessment`)).status(),
		).toBe(404);
		await candidate.reload();
		await expect(
			candidate.getByRole("heading", { name: "Interview in progress" }),
		).toBeVisible();
		await panelist.getByRole("button", { name: "End interview" }).click();
		await panelist
			.getByRole("dialog")
			.getByRole("button", { name: "End interview", exact: true })
			.click();
		await expect(
			panelistWorkspace.getByText("Final saved work · Read only"),
		).toBeVisible({ timeout: 12_000 });
		await expect(panelistSource).toContainText('print("Studio workspace 😀")');
		expect(
			(
				await candidate.request.get(
					`/api/interviews/rounds/${id}/workspace/code`,
				)
			).status(),
		).toBe(404);
		await expect(
			candidate.getByRole("heading", {
				name: "Interview ended or unavailable",
			}),
		).toBeVisible({ timeout: 12_000 });
		expect(
			(await candidate.request.get(`/api/interviews/rounds/${id}`)).status(),
		).toBe(404);
		await expect(
			panelist.getByText("Awaiting feedback", { exact: true }),
		).toBeVisible({ timeout: 12_000 });
		const openFeedback = attention.getByRole("link", {
			name: `Open feedback for ${applicant}`,
		});
		await expect(openFeedback).toBeVisible({ timeout: 12_000 });
		await panelistHome.setViewportSize({ width: 360, height: 800 });
		expect(
			await panelistHome.evaluate(() => document.documentElement.scrollWidth),
		).toBe(360);
		if (process.env.STUDIO_TEST_INTERVIEW_SCREENSHOTS) {
			await panelistHome.screenshot({
				path: info.outputPath("panelist-dashboard-mobile.png"),
				animations: "disabled",
			});
			await panelistHome.setViewportSize({ width: 1440, height: 900 });
			await panelistHome.evaluate(() =>
				document.documentElement.classList.add("dark"),
			);
			await panelistHome.screenshot({
				path: info.outputPath("panelist-dashboard-dark.png"),
				animations: "disabled",
			});
		}
		await openFeedback.press("Enter");
		await expect(panelistHome).toHaveURL(/#assessment$/);
		await expect(
			panelistHome.getByRole("region", { name: "Assessment", exact: true }),
		).toBeFocused();
		await expect(
			panelistHome.getByRole("button", { name: "Submit feedback" }),
		).toBeEnabled();
		await panelistHome.goto("/staff");
		await sheet.getByRole("button", { name: "Refresh details" }).click();
		await expect(
			sheet.getByText("Awaiting feedback", { exact: true }),
		).toBeVisible();
		const workspace = async (tab: string) => {
			const response = await hr.request.get(
				`/api/staff/interviews/workspace?tab=${tab}&search=${encodeURIComponent(email)}`,
			);
			expect(response.ok()).toBe(true);
			return response.json();
		};
		expect((await workspace("awaiting")).items).toMatchObject([
			{
				name: applicant,
				round: { id, state: "awaiting_feedback", closedAt: expect.any(String) },
			},
		]);
		expect((await workspace("history")).items).toEqual([]);
		const dashboard = await hrContext.newPage();
		await dashboard.goto("/staff");
		const awaitingItem = dashboard.getByRole("region", {
			name: "Awaiting feedback",
		});
		await expect(
			awaitingItem.getByText(applicant, { exact: true }),
		).toBeVisible();
		await expect(awaitingItem.getByText(/Ended /)).toBeVisible();
		await expect(
			dashboard.getByRole("region", { name: "Action needed" }),
		).not.toContainText(applicant);
		await awaitingItem
			.getByRole("link", { name: `View interview for ${applicant}` })
			.click();
		await expect(
			dashboard
				.getByRole("dialog")
				.getByText("Awaiting feedback", { exact: true }),
		).toBeVisible();
		if (process.env.STUDIO_TEST_INTERVIEW_SCREENSHOTS)
			await hr.screenshot({
				path: info.outputPath("hr-awaiting-feedback.png"),
				animations: "disabled",
			});
		await panelist.setViewportSize({ width: 1280, height: 900 });
		const meetingLink = panelist.getByRole("link", {
			name: "Open meeting at teams.example.test",
		});
		await expect(meetingLink).toBeVisible();
		expect(
			await meetingLink.evaluate(
				(link) => link.scrollWidth <= link.clientWidth,
			),
		).toBe(true);
		const submitFeedback = panelist.getByRole("button", {
			name: "Submit feedback",
		});
		await expect(submitFeedback).toBeEnabled({ timeout: 12_000 });
		await expect(
			panelist.getByText("Ready to submit", { exact: true }),
		).toBeVisible();
		if (process.env.STUDIO_TEST_INTERVIEW_SCREENSHOTS) {
			await panelist.evaluate(() => {
				document.documentElement.classList.add("dark");
				window.scrollTo(0, 0);
			});
			await panelist.screenshot({
				path: info.outputPath("panelist-feedback-desktop-dark.png"),
				animations: "disabled",
			});
			await panelist.evaluate(() =>
				document.documentElement.classList.remove("dark"),
			);
		}
		let committed: { payload: unknown; result: unknown } | undefined;
		await panelist.route(`**${assessmentPath}/submit`, async (route) => {
			const response = await route.fetch();
			expect(response.ok()).toBe(true);
			committed = {
				payload: route.request().postDataJSON(),
				result: await response.json(),
			};
			await route.abort("failed");
		});
		await submitFeedback.click();
		await expect(
			panelist.getByRole("heading", { name: "Submitted scorecard" }),
		).toBeVisible();
		await expect(
			panelist.getByRole("heading", { name: "Submitted scorecard" }),
		).toBeFocused();
		if (process.env.STUDIO_TEST_INTERVIEW_SCREENSHOTS)
			await panelist.screenshot({
				path: info.outputPath("panelist-submitted-desktop.png"),
				animations: "disabled",
			});
		expect(committed).toBeDefined();
		const retry = await panelist.request.post(`${assessmentPath}/submit`, {
			headers: write,
			data: committed?.payload,
		});
		expect(await retry.json()).toEqual(committed?.result);
		await expect(
			panelist.getByText("Feedback submitted", { exact: true }),
		).toBeVisible({ timeout: 12_000 });
		const submitted = panelistHome.getByRole("region", {
			name: "Recently submitted",
		});
		const viewScorecard = submitted.getByRole("link", {
			name: `View scorecard for ${applicant}`,
		});
		await expect(viewScorecard).toBeVisible({ timeout: 12_000 });
		await expect(attention).not.toContainText(applicant);
		await expect(
			submitted.getByText(/Submitted .*Asia\/Kolkata/),
		).toBeVisible();
		await viewScorecard.click();
		await expect(
			panelistHome.getByRole("heading", { name: "Submitted scorecard" }),
		).toBeVisible();
		await panelistHome.close();
		await sheet.getByRole("button", { name: "Refresh details" }).click();
		await expect(
			sheet.getByRole("heading", { name: "Submitted scorecard" }),
		).toBeVisible();
		await expect(
			sheet.getByText("Validated the approach with production examples."),
		).toBeVisible();
		await expect(
			sheet.getByText("What did you measure in production?"),
		).toHaveCount(0);
		await expect(sheet.getByText("Private questions and notes")).toHaveCount(0);

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
			state: "feedback_submitted",
			decision: "pass",
		});

		await hr.goto("/staff/settings");
		await expect(defaultDuration).toHaveValue("75");
		await defaultDuration.fill("60");
		await hr.getByRole("button", { name: "Save preferences" }).click();
		await expect(hr.getByRole("status")).toContainText(
			"Scheduling preferences saved.",
		);

		await hr.goto(`/staff/interviews?search=${encodeURIComponent(email)}`);
		await hr.getByLabel("Round", { exact: true }).click();
		await hr.getByRole("option", { name: "L2", exact: true }).click();
		await expect(hr).toHaveURL(/level=l2/);
		await expect(
			hr.getByText(/L1 passed · Platform Engineering/),
		).toBeVisible();
		await hr
			.getByRole("button", { name: "View L1 scorecard", exact: true })
			.click();
		await expect(
			hr
				.getByRole("dialog")
				.getByRole("heading", { name: "Submitted scorecard" }),
		).toBeVisible();
		await hr
			.getByRole("dialog")
			.getByRole("button", { name: "Close", exact: true })
			.click();
		expect((await workspace("history")).items).toEqual([]);
		await hr
			.getByRole("button", { name: `Schedule L2 for ${applicant}` })
			.click();
		sheet = hr.getByRole("dialog");
		const l1Summary = sheet.getByRole("region", {
			name: "L1 submitted scorecard",
		});
		const l2Criteria = sheet.getByRole("region", {
			name: "L2 scorecard criteria",
		});
		await expect(l1Summary.getByText("Pass", { exact: true })).toBeVisible();
		await expect(
			l1Summary.getByText("Validated the approach with production examples."),
		).toBeVisible();
		await expect(
			l2Criteria.getByText("Reviewed", { exact: true }),
		).toBeVisible();
		await expect(
			l2Criteria.getByText("System design", { exact: true }),
		).toBeVisible();
		const ratingsToggle = l1Summary
			.locator("summary")
			.filter({ hasText: "Skill ratings (2)" });
		const skill = l1Summary.getByText("Technical reasoning", { exact: true });
		await expect(skill).toBeHidden();
		if (process.env.STUDIO_TEST_INTERVIEW_SCREENSHOTS) {
			await hr.screenshot({
				path: info.outputPath("hr-schedule-l2-mobile.png"),
				animations: "disabled",
			});
			await hr.setViewportSize({ width: 1280, height: 900 });
			await hr.evaluate(() => document.documentElement.classList.add("dark"));
			await hr.screenshot({
				path: info.outputPath("hr-schedule-l2-desktop-dark.png"),
				animations: "disabled",
			});
			await hr.evaluate(() =>
				document.documentElement.classList.remove("dark"),
			);
			await hr.setViewportSize({ width: 390, height: 844 });
		}
		await ratingsToggle.press("Enter");
		await expect(skill).toBeVisible();
		await expect(
			l1Summary.getByText("Explained the trade-offs clearly."),
		).toBeVisible();
		await ratingsToggle.press("Enter");
		await expect(skill).toBeHidden();
		async function prepareL2() {
			await sheet
				.getByRole("combobox", { name: "Panelist" })
				.fill("slice4-other");
			await hr
				.getByRole("option", { name: /slice4-other@studio.test/ })
				.click();
			const slot = new Date(Date.now() + (330 + 2) * 60_000).toISOString();
			await sheet.getByLabel("Date", { exact: true }).fill(slot.slice(0, 10));
			await sheet.getByLabel("Start time").fill(slot.slice(11, 16));
			await sheet.getByRole("combobox", { name: "Interview mode" }).click();
			await hr.getByRole("option", { name: "In person", exact: true }).click();
			await sheet.getByLabel("Room", { exact: true }).fill("Studio test room");
		}
		async function bookL2() {
			await prepareL2();
			await sheet.getByRole("button", { name: "Book interview" }).click();
			await sheet.getByRole("button", { name: "Copy Studio link" }).click();
			await expect(sheet.getByRole("status")).toContainText(
				"Studio link copied",
			);
			const bookingId = new URL(hr.url()).searchParams.get("booking");
			if (!bookingId) throw new Error("L2 booking ID missing");
			return {
				id: bookingId,
				link: new URL(await hr.evaluate(() => navigator.clipboard.readText())),
			};
		}
		async function openNextL2() {
			await hr.goto(
				`/staff/interviews?level=l2&search=${encodeURIComponent(email)}`,
			);
			await hr
				.getByRole("button", { name: `Schedule L2 for ${applicant}` })
				.click();
		}
		async function scheduleNextL2() {
			await openNextL2();
			return bookL2();
		}
		const { id: l2Id, link: l2Link } = await bookL2();
		expect(l2Id).not.toBe(id);
		expect(l2Link.pathname).not.toBe(link.pathname);
		await expect(
			sheet.getByRole("heading", { name: "L1 submitted scorecard" }),
		).toBeVisible();

		const l2Panelist = await otherContext.newPage();
		await l2Panelist.setViewportSize({ width: 390, height: 844 });
		await l2Panelist.goto(`/staff/my-interviews/${l2Id}`);
		const handoff = l2Panelist.getByRole("region", {
			name: "L1 handoff",
			exact: true,
		});
		await expect(handoff.getByText("Pass", { exact: true })).toBeVisible();
		const acknowledge = handoff.getByRole("checkbox", {
			name: "I’ve reviewed this L1 scorecard",
		});
		await expect(acknowledge).toHaveCount(0);
		await expect(
			l2Panelist.getByText("Validated the approach with production examples."),
		).toBeVisible();
		await expect(
			l2Panelist.getByText("Keep these local observations."),
		).toHaveCount(0);
		if (process.env.STUDIO_TEST_INTERVIEW_SCREENSHOTS) {
			await l2Panelist
				.getByText("L1 handoff", { exact: true })
				.scrollIntoViewIfNeeded();
			await l2Panelist.screenshot({
				path: info.outputPath("panelist-l2-handoff-mobile.png"),
				animations: "disabled",
			});
		}
		expect(
			(
				await panelist.request.get(
					`/api/staff/my-interviews/${l2Id}/assessment`,
				)
			).status(),
		).toBe(404);
		expect(
			(await candidate.request.get(`/api/interviews/rounds/${l2Id}`)).status(),
		).toBe(401);
		async function startL2(invitation: string, message: number) {
			await candidate.goto(invitation);
			await candidate
				.getByRole("button", { name: "Join as candidate" })
				.click();
			await candidate.getByLabel("Invited email").fill(email);
			await candidate.getByRole("button", { name: "Send code" }).click();
			await candidate
				.getByLabel("Verification code")
				.fill(await mailCode(candidate.request, email, message));
			await candidate.getByRole("button", { name: "Verify code" }).click();
			await candidate.getByRole("button", { name: "Confirm and join" }).click();
			const start = l2Panelist.getByRole("button", { name: "Start interview" });
			await expect(start).toBeEnabled({ timeout: 12_000 });
			await start.click();
		}
		await startL2(l2Link.href, 2);
		await expect(
			candidate.getByText("L2 interview", { exact: true }),
		).toBeVisible({ timeout: 12_000 });
		const headerEnd = l2Panelist
			.locator("header")
			.filter({
				has: l2Panelist.getByRole("heading", { name: applicant, exact: true }),
			})
			.getByRole("button", { name: "End interview", exact: true });
		await expect(headerEnd).toBeVisible();
		await expect(acknowledge).toBeVisible();
		await expect(acknowledge).not.toBeChecked();
		await expect(
			l2Panelist.getByRole("heading", { name: "L2 manual assessment" }),
		).toBeVisible();
		await l2Panelist
			.getByLabel("System design", { exact: true })
			.selectOption("exceeds_expectations");
		await l2Panelist
			.getByLabel("Decision-making", { exact: true })
			.selectOption("meets_expectations");
		await l2Panelist
			.getByLabel("Decision", { exact: true })
			.selectOption("selected");
		await l2Panelist
			.getByLabel("Decision rationale")
			.fill("Designed a resilient service and explained its trade-offs.");
		await l2Panelist.getByRole("button", { name: "Save draft" }).click();
		await expect(
			l2Panelist.getByText("Draft saved", { exact: true }),
		).toBeVisible();
		if (process.env.STUDIO_TEST_INTERVIEW_SCREENSHOTS) {
			await l2Panelist.evaluate(() => window.scrollTo(0, 0));
			await l2Panelist.screenshot({
				path: info.outputPath("panelist-l2-active-mobile.png"),
				animations: "disabled",
			});
			await acknowledge.check();
			await l2Panelist.setViewportSize({ width: 1440, height: 900 });
			await l2Panelist.evaluate(() => {
				document.documentElement.classList.add("dark");
				window.scrollTo(0, 0);
			});
			await l2Panelist.screenshot({
				path: info.outputPath("panelist-l2-active-desktop-dark.png"),
				animations: "disabled",
			});
			await l2Panelist.evaluate(() =>
				document.documentElement.classList.remove("dark"),
			);
			await l2Panelist.setViewportSize({ width: 390, height: 844 });
			await acknowledge.uncheck();
		}
		await headerEnd.click();
		await l2Panelist
			.getByRole("button", { name: "Keep interview open" })
			.click();
		await expect(headerEnd).toBeFocused();
		expect(
			(
				await l2Panelist.request.get(
					`/api/staff/my-interviews/${l2Id}/concerns`,
				)
			).status(),
		).toBe(404);
		await expect(
			l2Panelist.getByText("Private observations", { exact: true }),
		).toHaveCount(0);
		await expect(
			candidate.getByText("Studio test room", { exact: true }),
		).toBeVisible();
		const pendingTools: string[] = [];
		const releaseSaves = Promise.withResolvers<void>();
		await candidate.route(
			`**/api/interviews/rounds/${l2Id}/workspace/*`,
			async (route) => {
				if (route.request().method() === "POST") {
					pendingTools.push(
						new URL(route.request().url()).pathname.split("/").at(-1) ?? "",
					);
					await releaseSaves.promise;
				}
				await route.continue();
			},
		);
		const closeCommands: unknown[] = [];
		await candidate.route(
			`**/api/interviews/rounds/${l2Id}/end`,
			async (route) => {
				closeCommands.push(route.request().postDataJSON());
				const response = await route.fetch();
				if (closeCommands.length === 1) await route.abort("failed");
				else await route.fulfill({ response });
			},
		);
		const l2Code = candidate.getByRole("region", {
			name: "Interview workspace",
		});
		await l2Code
			.getByLabel("Source code")
			.fill("const retainedAfterEnd = true;");
		try {
			await candidate.setViewportSize({ width: 1040, height: 900 });
			await l2Code.getByRole("tab", { name: "Whiteboard" }).click();
			const hiddenWorkBoard = l2Code.getByRole("tabpanel", {
				name: "Whiteboard",
			});
			await hiddenWorkBoard.getByTitle(/^Rectangle/).click({ timeout: 12_000 });
			const canvas = hiddenWorkBoard.locator("canvas.interactive");
			await canvas.scrollIntoViewIfNeeded();
			const bounds = await canvas.boundingBox();
			if (!bounds) throw new Error("Missing L2 whiteboard canvas");
			const x = bounds.x + bounds.width * 0.31;
			const y = bounds.y + bounds.height * 0.45;
			await candidate.mouse.move(x, y);
			await candidate.mouse.down();
			await candidate.mouse.move(x + 140, y + 80, { steps: 6 });
			await candidate.mouse.up();
			await candidate
				.getByRole("button", { name: "End interview", exact: true })
				.click();
			const confirmEnd = candidate
				.getByRole("dialog")
				.getByRole("button", { name: "End interview", exact: true });
			await expect(confirmEnd).toBeDisabled();
			await expect
				.poll(() => [...pendingTools].sort())
				.toEqual(["board", "code"]);
		} finally {
			releaseSaves.resolve();
		}
		const confirmEnd = candidate
			.getByRole("dialog")
			.getByRole("button", { name: "End interview", exact: true });
		await confirmEnd.click();
		await expect.poll(() => closeCommands.length).toBe(2);
		expect(closeCommands[1]).toEqual(closeCommands[0]);
		await expect(
			candidate.getByRole("heading", {
				name: "Interview ended or unavailable",
			}),
		).toBeFocused();
		await expect(l2Panelist.getByLabel("Source code")).toContainText(
			"const retainedAfterEnd = true;",
		);
		await expect(
			l2Panelist.getByText("Awaiting feedback", { exact: true }),
		).toBeVisible({ timeout: 12_000 });
		expect(
			(await candidate.request.get(`/api/interviews/rounds/${l2Id}`)).status(),
		).toBe(404);
		const l2PanelistWorkspace = l2Panelist.getByRole("region", {
			name: "Interview workspace",
		});
		await l2PanelistWorkspace.getByRole("tab", { name: "Whiteboard" }).click();
		await expect(
			l2PanelistWorkspace.getByText("Scene summary · 1 element", {
				exact: true,
			}),
		).toBeVisible();
		const finishL2 = l2Panelist.getByRole("button", {
			name: "Submit feedback",
		});
		await expect(finishL2).toBeDisabled();
		await acknowledge.check();
		await expect(finishL2).toBeEnabled();
		await correctL1("pass", "Added detail to the passing L1 feedback.");
		await expect(
			l2Panelist.getByText("Added detail to the passing L1 feedback.", {
				exact: true,
			}),
		).toBeVisible({ timeout: 12_000 });
		await expect(acknowledge).not.toBeChecked();
		await expect(finishL2).toBeDisabled();
		await acknowledge.check();
		await finishL2.click();
		await expect(
			l2Panelist.getByRole("heading", { name: "Submitted scorecard" }),
		).toBeFocused();
		await expect(
			l2Panelist.getByRole("heading", {
				name: "L1 handoff used for submission",
			}),
		).toBeVisible();
		await sheet.getByRole("button", { name: "Refresh details" }).click();
		await expect(
			sheet.getByRole("heading", { name: "Submitted scorecard" }),
		).toBeVisible();
		await expect(sheet.getByText("Selected", { exact: true })).toBeVisible();
		await sheet.getByRole("button", { name: "Close", exact: true }).click();
		expect((await workspace("history")).items).toMatchObject([
			{ name: applicant, outcome: "selected" },
		]);
		await dashboard.goto("/staff");
		const recent = dashboard.getByRole("region", { name: "Recent outcomes" });
		await expect(recent.getByText("Selected", { exact: true })).toBeVisible();
		await recent
			.getByRole("button", { name: `View interview history for ${applicant}` })
			.click();
		await expect(
			dashboard
				.getByRole("dialog")
				.getByRole("heading", { name: "L2 · Attempt 1" }),
		).toBeVisible();
		await dashboard.close();
		await hr.getByRole("tab", { name: "History", exact: true }).click();
		await hr
			.getByRole("button", { name: `View interview history for ${applicant}` })
			.click();
		await expect(
			sheet.getByRole("heading", { name: "L1 · Attempt 1" }),
		).toBeVisible();
		await expect(
			sheet.getByRole("heading", { name: "L2 · Attempt 1" }),
		).toBeVisible();
		await sheet.getByRole("button", { name: "View L1 scorecard" }).click();
		await expect(
			sheet.getByText("Added detail to the passing L1 feedback.", {
				exact: true,
			}),
		).toBeVisible();
		if (process.env.STUDIO_TEST_INTERVIEW_SCREENSHOTS)
			await hr.screenshot({
				path: info.outputPath("hr-candidacy-timeline-mobile.png"),
				animations: "disabled",
			});
		await sheet.getByRole("button", { name: "Close", exact: true }).click();
		await hr.getByRole("tab", { name: "Action needed" }).click();
		await expect(
			hr.getByRole("button", { name: `Schedule L2 for ${applicant}` }),
		).toHaveCount(0);
		const hrObserver = await hrContext.newPage();
		await hrObserver.goto(`/staff/interviews?tab=history&booking=${l2Id}`);
		const observedBooking = hrObserver.getByRole("dialog");
		const pendingReview = observedBooking.getByRole("link", {
			name: "Open feedback review",
		});
		await expect(
			observedBooking.getByText("Selected", { exact: true }),
		).toBeVisible();
		await expect(pendingReview).toHaveCount(0);
		const historyPath = `**/api/staff/interviews/${l2Id}/assessment/versions?*`;
		const initialVersions = await hrObserver.request.get(
			`/api/staff/interviews/${l2Id}/assessment/versions`,
		);
		expect(initialVersions.ok()).toBe(true);
		const firstVersionPage = {
			...(await initialVersions.json()),
			hasNext: true,
		};
		const releaseHistoryPage = Promise.withResolvers<void>();
		await hrObserver.route(historyPath, async (route) => {
			const page = new URL(route.request().url()).searchParams.get("page");
			if (page === "2") {
				await releaseHistoryPage.promise;
				await route.fulfill({ json: { page: 2, hasNext: false, items: [] } });
				return;
			}
			await route.fulfill({ json: firstVersionPage });
		});
		await observedBooking.getByText("Version history", { exact: true }).click();
		const pager = observedBooking.getByRole("navigation", {
			name: "Scorecard history pages",
		});
		const nextVersionPage = pager.getByRole("button", { name: "Next" });
		try {
			await nextVersionPage.press("Enter");
			await expect(nextVersionPage).toBeFocused();
			await expect(nextVersionPage).toHaveAttribute("aria-disabled", "true");
		} finally {
			releaseHistoryPage.resolve();
		}
		await expect(pager).toContainText("Page 2");
		await expect(nextVersionPage).toBeFocused();
		await pager.getByRole("button", { name: "Previous" }).click();
		await expect(pager).toContainText("Page 1");
		const selectedVersion = observedBooking.getByRole("button", {
			name: "Version 1 · Selected",
		});
		await selectedVersion.click();
		await expect(selectedVersion).toHaveAttribute("aria-expanded", "true");
		const l2AssessmentRoute = `**/api/staff/interviews/${l2Id}/assessment`;
		await hrObserver.route(l2AssessmentRoute, (route) =>
			route.fulfill({ status: 503, json: {} }),
		);
		await expect(observedBooking.getByRole("alert")).toContainText(
			"Couldn’t reach Interview Studio. Try again.",
			{ timeout: 20_000 },
		);
		await expect(selectedVersion).toHaveAttribute("aria-expanded", "true");
		await hrObserver.unroute(l2AssessmentRoute);
		const correctL2 = l2Panelist.getByRole("button", {
			name: "Correct feedback",
			exact: true,
		});
		await expect(correctL2).toBeVisible();

		async function correctL1(
			decision: "pass" | "do_not_proceed",
			rationale: string,
		) {
			await panelist
				.getByRole("button", { name: "Correct feedback", exact: true })
				.press("Enter");
			const correction = panelist.getByRole("form", {
				name: "Correct feedback",
			});
			await expect(
				correction.getByRole("heading", { name: "Correct feedback" }),
			).toBeFocused();
			await correction
				.getByLabel("Decision", { exact: true })
				.selectOption(decision);
			await correction.getByLabel("Decision rationale").fill(rationale);
			await expect(
				correction.getByRole("button", { name: "Save correction" }),
			).toBeDisabled();
			await correction
				.getByLabel("Correction reason")
				.fill("Panel scorecard evidence verified.");
			await correction.getByRole("button", { name: "Save correction" }).click();
			await expect(correction).toHaveCount(0);
			await expect(
				panelist.getByText(rationale, { exact: true }),
			).toBeVisible();
		}
		await hr.getByRole("tab", { name: "Action needed" }).click();
		await hr.getByRole("button", { name: "Refresh interviews" }).click();
		const update = hr.getByRole("button", {
			name: `Open feedback update for ${applicant}`,
		});
		await update.click();
		await expect(hr).toHaveURL(/[?&]review=/);
		await expect(
			sheet.getByText("L1 feedback updated", { exact: true }),
		).toBeVisible();
		await sheet.getByRole("button", { name: "Mark as read" }).click();
		await expect(sheet.getByText(/Read by Maya Patel/)).toBeVisible();
		await sheet.getByRole("button", { name: "Close", exact: true }).click();
		await expect(update).toHaveCount(0);

		await correctL1(
			"do_not_proceed",
			"Reversed the pass after checking the evidence.",
		);
		await Promise.all([
			expect(pendingReview).toBeVisible({ timeout: 12_000 }),
			expect(correctL2).toHaveCount(0, { timeout: 12_000 }),
		]);
		await hr.getByRole("button", { name: "Refresh interviews" }).click();
		const openReview = hr.getByRole("button", {
			name: `Resolve feedback review for ${applicant}`,
		});
		expect((await workspace("history")).items).toEqual([]);
		await openReview.click();
		await expect(hr).toHaveURL(/[?&]review=/);
		const resolvedReviewId = new URL(hr.url()).searchParams.get("review");
		expect(resolvedReviewId).toBeTruthy();
		await expect(
			sheet.getByText("Close this candidacy with Do not proceed.", {
				exact: true,
			}),
		).toBeVisible();
		await expect(
			sheet.getByRole("button", { name: "Apply L1 decision" }),
		).toBeDisabled();
		if (process.env.STUDIO_TEST_INTERVIEW_SCREENSHOTS)
			await hr.screenshot({
				path: info.outputPath("hr-review-mobile.png"),
				animations: "disabled",
			});
		const reason = sheet.getByLabel("Resolution reason");
		await reason.fill(
			"Compared both submitted scorecards and the original handoff.",
		);
		await sheet.getByText("L1 before the correction", { exact: true }).click();
		await expect(
			sheet.getByText("Added detail to the passing L1 feedback.", {
				exact: true,
			}),
		).toBeVisible();
		await expect(
			sheet.getByRole("link", { name: "Open this scorecard" }),
		).toHaveAttribute("href", /[?&]version=/);
		const inReview = await hr.request.get(`/api/staff/interviews/${l2Id}`);
		expect(await inReview.json()).toMatchObject({
			decision: "selected",
			effectiveOutcome: null,
			pendingReviewId: expect.any(String),
		});

		await correctL1(
			"pass",
			"Restored the pass after reviewing the original evidence.",
		);
		await hr.evaluate(() =>
			window.dispatchEvent(new Event("visibilitychange")),
		);
		await expect(
			sheet.getByText("The review has a newer L1 version", { exact: true }),
		).toBeVisible({ timeout: 12_000 });
		await expect(reason).toHaveValue(
			"Compared both submitted scorecards and the original handoff.",
		);
		await expect(
			sheet.getByRole("button", { name: "Reinstate L2 feedback" }),
		).toBeDisabled();
		await sheet
			.getByRole("button", { name: "Use the current L1 decision" })
			.click();
		await expect(
			sheet.getByText("Restore Selected as the hiring decision.", {
				exact: true,
			}),
		).toBeVisible();
		await hr.setViewportSize({ width: 1280, height: 900 });
		await expect(reason).toHaveValue(
			"Compared both submitted scorecards and the original handoff.",
		);
		if (process.env.STUDIO_TEST_INTERVIEW_SCREENSHOTS)
			await hr.screenshot({
				path: info.outputPath("hr-review-desktop.png"),
				animations: "disabled",
			});
		await sheet.getByRole("button", { name: "Reinstate L2 feedback" }).click();
		await expect(
			sheet.getByRole("heading", { name: "Review resolved" }),
		).toBeVisible();
		await sheet.getByRole("button", { name: "Close", exact: true }).click();
		await expect(hr.getByRole("tab", { name: "Action needed" })).toBeFocused();
		const reinstated = await hr.request.get(`/api/staff/interviews/${l2Id}`);
		expect(await reinstated.json()).toMatchObject({
			effectiveOutcome: "selected",
			pendingReviewId: null,
		});
		await Promise.all([
			expect(pendingReview).toHaveCount(0, { timeout: 12_000 }),
			expect(correctL2).toBeVisible({ timeout: 12_000 }),
		]);
		await expect(
			l2Panelist.getByText("Added detail to the passing L1 feedback.", {
				exact: true,
			}),
		).toBeVisible();

		await correctL2.click();
		const l2Correction = l2Panelist.getByRole("form", {
			name: "Correct feedback",
		});
		await l2Correction
			.getByLabel("Decision", { exact: true })
			.selectOption("incomplete");
		await l2Correction
			.getByLabel("Correction reason")
			.fill("The panel needs another round.");
		await l2Correction.getByRole("button", { name: "Save correction" }).click();
		await expect(l2Correction).toHaveCount(0);
		const { id: freshL2Id, link: freshL2Link } = await scheduleNextL2();
		expect(freshL2Id).not.toBe(l2Id);
		await l2Panelist.goto(`/staff/my-interviews/${freshL2Id}`);
		await startL2(freshL2Link.href, 3);
		await l2Panelist
			.getByLabel("System design", { exact: true })
			.selectOption("meets_expectations");
		await l2Panelist
			.getByRole("button", {
				name: "Add feedback for System design",
			})
			.click();
		await l2Panelist
			.getByLabel("Feedback for System design", { exact: true })
			.fill("Explained request tracing.");
		await l2Panelist
			.getByLabel("Decision rationale")
			.fill("Saved rationale from the second L2.");
		await l2Panelist.getByRole("button", { name: "Save draft" }).click();
		await expect(
			l2Panelist.getByText("Draft saved", { exact: true }),
		).toBeVisible();
		await l2Panelist
			.getByLabel("Private notes")
			.fill("Notes still local in this tab.");
		await expect(sheet.getByText("Active", { exact: true })).toBeVisible({
			timeout: 12_000,
		});
		await sheet.getByRole("button", { name: "Manage booking" }).click();
		await hr.getByRole("menuitem", { name: "Withdraw candidacy" }).click();
		const withdrawalReason = sheet.getByLabel("Reason", { exact: true });
		const withdraw = sheet.getByRole("button", { name: "Withdraw candidate" });
		await withdrawalReason.fill("Draft staffing explanation.");
		await expect(withdraw).toBeEnabled();
		await correctL1(
			"do_not_proceed",
			"Reversed the pass during the second L2.",
		);
		await expect(
			l2Panelist.getByText("Cancelled", { exact: true }),
		).toBeVisible({ timeout: 12_000 });
		await expect(
			sheet.getByText("Pending HR review", { exact: true }),
		).toBeVisible({ timeout: 12_000 });
		await expect(withdraw).toBeDisabled();
		await expect(withdrawalReason).toBeDisabled();
		await expect(withdrawalReason).toHaveValue("Draft staffing explanation.");
		const savedDraft = l2Panelist.getByRole("region", {
			name: "Saved draft scorecard",
		});
		await expect(
			savedDraft
				.getByRole("definition")
				.filter({ hasText: "Explained request tracing." }),
		).toContainText("Meets expectations");
		await expect(
			savedDraft.getByText("Saved rationale from the second L2.", {
				exact: true,
			}),
		).toBeVisible();
		await expect(
			l2Panelist.getByRole("button", { name: "Save draft" }),
		).toHaveCount(0);
		await expect(
			l2Panelist.getByRole("heading", { name: "L1 handoff" }),
		).toHaveCount(0);
		await l2Panelist.getByText("Your unsaved changes", { exact: true }).click();
		await expect(
			l2Panelist.getByText("Notes still local in this tab.", { exact: true }),
		).toBeVisible();

		await correctL1("pass", "Restored the pass and requested a fresh L2.");
		const detail = await hr.request.get(`/api/staff/interviews/${freshL2Id}`);
		expect(detail.ok()).toBe(true);
		const { pendingReviewId } = await detail.json();
		expect(pendingReviewId).toBeTruthy();
		const reviewPath = `/api/staff/interviews/reviews/${pendingReviewId.toUpperCase()}`;
		const reviewResponse = await hr.request.get(reviewPath);
		expect(reviewResponse.ok()).toBe(true);
		const review = await reviewResponse.json();
		const resolve = await hr.request.post(`${reviewPath}/resolve`, {
			headers: write,
			data: {
				commandId: randomUUID(),
				expectedRevision: review.revision,
				expectedL1VersionId: review.latestL1.id,
				action: "rebook_l2",
				reason: "The unfinished interview needs a fresh booking.",
			},
		});
		expect(resolve.ok()).toBe(true);
		const { id: cancelledId } = await scheduleNextL2();
		const cancelled = await hr.request.post(
			`/api/staff/interviews/${cancelledId}/commands`,
			{
				headers: write,
				data: { action: "cancel", commandId: randomUUID(), revision: 0 },
			},
		);
		expect(cancelled.ok()).toBe(true);
		await hrObserver.goto(
			`/staff/interviews?tab=history&booking=${cancelledId}`,
		);
		await expect(
			observedBooking.getByText("Cancelled", { exact: true }),
		).toBeVisible();
		await expect(pendingReview).toHaveCount(0);
		await openNextL2();
		await prepareL2();
		const book = sheet.getByRole("button", { name: "Book interview" });
		await expect(book).toBeEnabled();
		const displayedTime = await sheet.getByLabel("Start time").inputValue();
		await correctL1(
			"do_not_proceed",
			"Reversed the pass after HR cancelled the booking.",
		);
		await expect(pendingReview).toBeVisible({ timeout: 12_000 });
		await expect(book).toBeDisabled({ timeout: 12_000 });
		await expect(
			sheet.getByRole("button", { name: "Withdraw candidacy" }),
		).toBeDisabled();
		await expect(sheet.getByLabel("Start time")).toHaveValue(displayedTime);
		await hrObserver.goto(
			`/staff/interviews?tab=queue&level=l2&search=${encodeURIComponent(email)}`,
		);
		await hrObserver
			.getByRole("button", { name: `View interview timeline for ${applicant}` })
			.click();
		const rows = observedBooking
			.getByRole("list", { name: "Interview attempts" })
			.getByRole("listitem");
		const retired = rows.filter({ hasText: "L2 · Attempt 1" });
		await expect(
			retired.getByText("Superseded", { exact: true }),
		).toBeVisible();
		await expect(
			retired.getByText("Pending HR review", { exact: true }),
		).toHaveCount(0);
		await expect(
			rows
				.filter({ hasText: "L2 · Attempt 3" })
				.getByText("Pending HR review", { exact: true }),
		).toBeVisible();
		await hrObserver.goto(
			`/staff/interviews?tab=reviews&review=${resolvedReviewId}`,
		);
		const resolved = observedBooking.getByRole("heading", {
			name: "Review resolved",
		});
		await expect(resolved).toBeVisible();
		await expect(savedDraft).toBeVisible();
		for (const [page, protectedPath, privateContent] of [
			[
				hrObserver,
				`/api/staff/interviews/reviews/${resolvedReviewId}`,
				resolved,
			],
			[
				l2Panelist,
				`/api/staff/my-interviews/${freshL2Id}/assessment`,
				savedDraft,
			],
		] as const) {
			await page.bringToFront();
			const signedOut = await page.request.post("/api/auth/sign-out", {
				headers: write,
			});
			expect(signedOut.ok()).toBe(true);
			expect((await page.request.get("/api/staff/me")).status()).toBe(401);
			expect((await page.request.get(protectedPath)).status()).toBe(401);
			await expect(privateContent).toHaveCount(0, { timeout: 12_000 });
		}
		expect(
			(
				await l2Panelist.request.get(
					`/api/staff/my-interviews/${freshL2Id}/workspace`,
				)
			).status(),
		).toBe(401);
		await expect(
			l2Panelist.getByRole("region", { name: "Interview workspace" }),
		).toHaveCount(0);
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
		if (
			request.method() === "GET" &&
			url.pathname === "/api/staff/interviews/workspace"
		)
			listReads.push(url.searchParams.get("tab") ?? "queue");
	});
	if (process.env.STUDIO_TEST_INTERVIEW_SCREENSHOTS) {
		await page.addInitScript(() =>
			localStorage.setItem("interview-studio-theme", "dark"),
		);
	}
	await page.goto("/staff/interviews");
	const tabs = ["Action needed", "Scheduled", "Awaiting feedback", "History"];
	for (const name of tabs) {
		await page.getByRole("tab", { name, exact: true }).click();
		await expect(
			page.getByRole("tabpanel", { name, exact: true }),
		).toHaveAttribute("aria-busy", "false");
	}
	expect(listReads).toEqual(["queue", "scheduled", "awaiting", "history"]);
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
	expect(listReads).toEqual(["queue", "scheduled", "awaiting", "history"]);
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
	const skillsPath = `/api/staff/drives/${seededDrive}/skills/l1`;
	const savedSkills = await page.request.put(skillsPath, {
		headers: { origin: baseURL },
		data: {
			revision: candidate.criteria.revision,
			skills: [{ name: "Updated booking criteria" }],
		},
	});
	expect(savedSkills.ok()).toBe(true);
	const reviewedSkills = await page.request.post(`${skillsPath}/review`, {
		headers: { origin: baseURL },
		data: { revision: (await savedSkills.json()).revision },
	});
	expect(reviewedSkills.ok()).toBe(true);
	const refreshQueue = async () => {
		const refreshed = page.waitForResponse((response) => {
			const url = new URL(response.url());
			return (
				url.pathname === "/api/staff/interviews/workspace" &&
				url.searchParams.get("tab") === "queue" &&
				response.request().method() === "GET"
			);
		});
		await page.evaluate(() =>
			window.dispatchEvent(new Event("visibilitychange")),
		);
		return (await refreshed).json();
	};
	await refreshQueue();
	await expect(
		sheet.getByText("Updated booking criteria", { exact: true }),
	).toBeVisible();
	await sheet.getByRole("button", { name: "Use current criteria" }).click();
	await sheet.getByRole("button", { name: "Book interview" }).click();
	await expect(sheet.getByRole("alert")).toContainText(
		"Candidate · Infrastructure Hiring",
	);

	let recoveredId: string | undefined;
	let cancelledWhileRecovering = false;
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
		const refreshedQueue = await refreshQueue();
		expect(
			refreshedQueue.items.map((item: { id: string }) => item.id),
		).not.toContain(candidate.id);
		await expect(
			sheet.getByText("Updated booking criteria", { exact: true }),
		).toBeVisible();
		await expect(date).toHaveValue(start.slice(0, 10));
		await expect(time).toHaveValue(start.slice(11, 16));
		const cancelled = await page.request.post(
			`/api/staff/interviews/${recoveredId}/commands`,
			{
				headers: { origin: baseURL },
				data: { action: "cancel", commandId: randomUUID(), revision: 0 },
			},
		);
		expect(cancelled.ok()).toBe(true);
		cancelledWhileRecovering = true;
		const newer = await page.request.put(skillsPath, {
			headers: { origin: baseURL },
			data: {
				revision: (await reviewedSkills.json()).revision,
				skills: [{ name: "Criteria for later attempts" }],
			},
		});
		expect(newer.ok()).toBe(true);
		expect(
			(
				await page.request.post(`${skillsPath}/review`, {
					headers: { origin: baseURL },
					data: { revision: (await newer.json()).revision },
				})
			).ok(),
		).toBe(true);
		const rebookQueue = await refreshQueue();
		expect(rebookQueue.items).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					id: candidate.id,
					eligible: expect.objectContaining({ lastAttempt: 1 }),
				}),
			]),
		);
		await sheet.getByRole("button", { name: "Retry booking" }).click();
		await expect(close).toBeDisabled();
		await page.keyboard.press("Escape");
		await expect(
			sheet.getByRole("heading", { name: "Schedule L1" }),
		).toBeVisible();
		delayedSuccess.resolve();
		await expect(sheet.getByText("Cancelled", { exact: true })).toBeVisible();
		expect(recoveredId).toBeTruthy();
		expect(new URL(page.url()).searchParams.get("booking")).toBe(recoveredId);
		expect(approvedBodies).toHaveLength(2);
		expect(approvedBodies[0]).toMatchObject({
			candidateRevision: candidate.revision + 1,
			skillRevision: (await reviewedSkills.json()).revision,
		});
		expect(approvedBodies[0]).toEqual(approvedBodies[1]);
		await sheet.getByRole("button", { name: "Close", exact: true }).click();
		await page.getByRole("tab", { name: "History", exact: true }).click();
		await expect(
			page.getByRole("button", {
				name: "View interview history for Avery Morgan",
				exact: true,
			}),
		).toHaveCount(0);
		await page.getByRole("tab", { name: "Action needed", exact: true }).click();
		await expect(
			page.getByRole("tabpanel", { name: "Action needed" }),
		).toHaveAttribute("aria-busy", "false");
		await expect(opener).toBeVisible();
		await page
			.getByRole("button", {
				name: "View interview timeline for Avery Morgan",
				exact: true,
			})
			.click();
		await expect(sheet.getByText("Cancelled", { exact: true })).toBeVisible();
		await sheet.getByRole("button", { name: "Close", exact: true }).click();
	} finally {
		delayedFailure.resolve();
		delayedSuccess.resolve();
		await page.unroute("**/api/staff/interviews");
		if (recoveredId && !cancelledWhileRecovering) {
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
