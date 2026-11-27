import {
	acknowledgeFeedbackReviewSchema,
	assessmentVersionDetailSchema,
	assessmentVersionListSchema,
	assessmentViewSchema,
	assignedInterviewSchema,
	assignedInterviewsSchema,
	bookInterviewSchema,
	canManageInterviews,
	canViewAssignedInterviews,
	correctAssessmentSchema,
	directorReportQuerySchema,
	eligibleInterviewCandidateSchema,
	feedbackReviewDetailSchema,
	feedbackReviewListSchema,
	hrAssessmentSchema,
	hrInterviewSchema,
	initializeAssessmentSchema,
	interviewCommandSchema,
	interviewInvitationSchema,
	interviewListQuerySchema,
	interviewPageNumberSchema,
	interviewPanelistsSchema,
	interviewPreferencesSchema,
	interviewResultSchema,
	interviewSlotPreviewSchema,
	interviewSlotSchema,
	interviewWorkspaceQuerySchema,
	panelistDashboardSchema,
	panelistRoundGroupSchema,
	resolveFeedbackReviewSchema,
	type StaffIdentity,
	saveAssessmentDraftSchema,
	submitAssessmentSchema,
	withdrawCandidacySchema,
} from "@studio/contracts";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { logger } from "../logger.ts";
import {
	changeAssessment,
	correctAssessment,
	getAssessmentVersion,
	getAssignedAssessment,
	getHrAssessment,
	listAssessmentVersions,
} from "./assessments.ts";
import {
	listDirectorScorecards,
	readDirectorReport,
} from "./director-report.ts";
import {
	changeFeedbackReview,
	getFeedbackReview,
	listFeedbackReviews,
} from "./feedback-reviews.ts";
import { readBody, uuidParam } from "./http.ts";
import { InterviewProblem } from "./problem.ts";
import {
	findPanelists,
	getAssignedRound,
	getBookingEligibility,
	getHrRound,
	getPanelistDashboard,
	listAssignedRounds,
	listInterviews,
	listInterviewTimeline,
	listInterviewWorkspace,
	readHrInterviewDashboard,
	resolveStaffInvite,
} from "./queries.ts";
import {
	bookInterview,
	changeRound,
	copyInvitation,
	withdrawCandidacy,
} from "./scheduling.ts";
import {
	currentTime,
	type Database,
	type InterviewConfig,
	readPreferences,
	savePreferences,
} from "./store.ts";

import { resolveSlot } from "./time.ts";

const slotQuery = interviewSlotSchema.extend({
	timeZone: z.string().max(100),
	duration: z.coerce.number().int().min(5).max(480),
});
const smallBody = bodyLimit({ maxSize: 4_096 });
const assessmentBody = bodyLimit({
	// Each supplementary Unicode code point can take 12 bytes when JSON-escaped.
	maxSize: 1024 * 1024,
	onError: (c) => c.json({ error: "invalid_input" }, 413),
});

function pageNumber(value: string | undefined) {
	const page = interviewPageNumberSchema.default(1).safeParse(value);
	if (!page.success) throw new InterviewProblem(400, "invalid_input");
	return page.data;
}

export function interviewStaffRoutes(
	database: Database,
	config: InterviewConfig,
) {
	const app = new Hono<{ Variables: { staff: StaffIdentity } }>();
	app.use("/reports/*", async (c, next) => {
		if (c.get("staff").role !== "director")
			throw new InterviewProblem(403, "forbidden");
		await next();
	});
	for (const [path, allowed] of [
		["/interviews/*", canManageInterviews],
		["/settings/interviews/*", canManageInterviews],
		["/my-interviews/*", canViewAssignedInterviews],
	] as const) {
		app.use(path, async (c, next) => {
			if (!allowed(c.get("staff").role))
				throw new InterviewProblem(403, "forbidden");
			await next();
		});
	}

	app.get("/reports/interviews", async (c) => {
		const query = directorReportQuerySchema.safeParse(c.req.query());
		if (!query.success) throw new InterviewProblem(400, "invalid_input");
		return c.json(await readDirectorReport(database, query.data));
	});
	app.get(
		"/reports/interviews/candidacies/:driveId/:candidateId/scorecards",
		async (c) =>
			c.json(
				await listDirectorScorecards(
					database,
					{
						driveId: uuidParam(c.req.param("driveId")),
						candidateId: uuidParam(c.req.param("candidateId")),
					},
					pageNumber(c.req.query("page")),
				),
			),
	);
	app.get("/reports/interviews/rounds/:roundId/versions", async (c) =>
		c.json(
			assessmentVersionListSchema.parse(
				await listAssessmentVersions(
					database,
					config,
					c.get("staff").id,
					"director",
					uuidParam(c.req.param("roundId")),
					pageNumber(c.req.query("page")),
				),
			),
		),
	);
	app.get(
		"/reports/interviews/rounds/:roundId/versions/:versionId",
		async (c) =>
			c.json(
				assessmentVersionDetailSchema.parse(
					await getAssessmentVersion(
						database,
						config,
						c.get("staff").id,
						"director",
						uuidParam(c.req.param("roundId")),
						uuidParam(c.req.param("versionId")),
					),
				),
			),
	);

	app.get("/settings/interviews/slot", (c) => {
		const query = slotQuery.safeParse(c.req.query());
		if (!query.success) throw new InterviewProblem(422, "invalid_slot");
		const slot = resolveSlot(query.data, query.data.timeZone);
		return c.json(
			interviewSlotPreviewSchema.parse({
				start: slot.start.toISOString(),
				end: slot.end.toISOString(),
				offsets: slot.offsets,
			}),
		);
	});
	app.get("/settings/interviews", async (c) =>
		c.json(
			interviewPreferencesSchema.parse(
				await readPreferences(database, c.get("staff").id),
			),
		),
	);
	app.patch("/settings/interviews", smallBody, async (c) =>
		c.json(
			interviewPreferencesSchema.parse(
				await savePreferences(
					database,
					config,
					c.get("staff").id,
					await readBody(c, interviewPreferencesSchema),
				),
			),
		),
	);

	app.get("/interviews", async (c) => {
		const query = interviewListQuerySchema.safeParse(c.req.query());
		if (!query.success) throw new InterviewProblem(400, "invalid_input");
		return c.json(
			await listInterviews(
				database,
				query.data,
				currentTime(config),
				config.domains,
			),
		);
	});
	app.get("/interviews/panelists", async (c) => {
		const search = c.req.query("search")?.trim() ?? "";
		if (search.length > 120) throw new InterviewProblem(400, "invalid_input");
		return c.json(
			interviewPanelistsSchema.parse(
				await findPanelists(database, config.domains, search),
			),
		);
	});
	app.get("/interviews/workspace", async (c) => {
		const query = interviewWorkspaceQuerySchema.safeParse(c.req.query());
		if (!query.success) throw new InterviewProblem(400, "invalid_input");
		return c.json(
			await listInterviewWorkspace(
				database,
				query.data,
				currentTime(config),
				config.domains,
			),
		);
	});
	app.get("/interviews/dashboard", async (c) =>
		c.json(
			await readHrInterviewDashboard(
				database,
				currentTime(config),
				config.domains,
			),
		),
	);
	app.get("/interviews/candidacies/:driveId/:candidateId/timeline", async (c) =>
		c.json(
			await listInterviewTimeline(
				database,
				{
					driveId: uuidParam(c.req.param("driveId")),
					candidateId: uuidParam(c.req.param("candidateId")),
				},
				pageNumber(c.req.query("page")),
				currentTime(config),
				config.domains,
			),
		),
	);
	app.post("/interviews", smallBody, async (c) => {
		const input = await readBody(c, bookInterviewSchema);
		const result = await bookInterview(
			database,
			config,
			c.get("staff").id,
			input,
		);
		logger.info({ stage: "interview_booked" }, "Interview scheduling");
		return c.json(interviewResultSchema.parse(result));
	});
	app.get(
		"/interviews/candidacies/:driveId/:candidateId/eligibility",
		async (c) =>
			c.json(
				eligibleInterviewCandidateSchema.parse(
					await getBookingEligibility(database, {
						driveId: uuidParam(c.req.param("driveId")),
						candidateId: uuidParam(c.req.param("candidateId")),
					}),
				),
			),
	);
	app.post(
		"/interviews/candidacies/:driveId/:candidateId/withdraw",
		smallBody,
		async (c) => {
			const scope = {
				driveId: uuidParam(c.req.param("driveId")),
				candidateId: uuidParam(c.req.param("candidateId")),
			};
			return c.json(
				interviewResultSchema.parse(
					await withdrawCandidacy(
						database,
						config,
						c.get("staff").id,
						scope,
						await readBody(c, withdrawCandidacySchema),
					),
				),
			);
		},
	);
	app.get("/interviews/reviews", async (c) =>
		c.json(
			feedbackReviewListSchema.parse(
				await listFeedbackReviews(
					database,
					config,
					c.get("staff").id,
					pageNumber(c.req.query("page")),
					c.req.query("kind") === "updates",
				),
			),
		),
	);
	app.get("/interviews/reviews/:reviewId", async (c) =>
		c.json(
			feedbackReviewDetailSchema.parse(
				await getFeedbackReview(
					database,
					config,
					c.get("staff").id,
					uuidParam(c.req.param("reviewId")),
				),
			),
		),
	);
	app.post(
		"/interviews/reviews/:reviewId/resolve",
		assessmentBody,
		async (c) => {
			const input = await readBody(c, resolveFeedbackReviewSchema);
			return c.json(
				interviewResultSchema.parse(
					await changeFeedbackReview(
						database,
						config,
						c.get("staff").id,
						uuidParam(c.req.param("reviewId")),
						{
							action: "resolve",
							commandId: input.commandId,
							resolution: input,
						},
					),
				),
			);
		},
	);
	app.post("/interviews/reviews/:reviewId/acknowledge", smallBody, async (c) =>
		c.json(
			interviewResultSchema.parse(
				await changeFeedbackReview(
					database,
					config,
					c.get("staff").id,
					uuidParam(c.req.param("reviewId")),
					{
						action: "acknowledge",
						...(await readBody(c, acknowledgeFeedbackReviewSchema)),
					},
				),
			),
		),
	);
	app.get("/interviews/:id", async (c) =>
		c.json(
			hrInterviewSchema.parse(
				await getHrRound(
					database,
					uuidParam(c.req.param("id")),
					currentTime(config),
					config.domains,
				),
			),
		),
	);
	app.get("/interviews/:id/assessment", async (c) => {
		const known = c.req.header("If-None-Match");
		const view = await getHrAssessment(
			database,
			config,
			c.get("staff").id,
			uuidParam(c.req.param("id")),
			known,
		);
		c.header("ETag", view?.revisionTag ?? known);
		return view ? c.json(hrAssessmentSchema.parse(view)) : c.body(null, 304);
	});
	app.get("/interviews/:id/invitation", async (c) =>
		c.json(
			interviewInvitationSchema.parse(
				await copyInvitation(database, config, uuidParam(c.req.param("id"))),
			),
		),
	);
	app.post("/interviews/:id/commands", smallBody, async (c) => {
		const input = await readBody(c, interviewCommandSchema);
		if (input.action === "start")
			throw new InterviewProblem(409, "invalid_transition");
		return c.json(
			interviewResultSchema.parse(
				await changeRound(
					database,
					config,
					c.get("staff").id,
					"hr",
					uuidParam(c.req.param("id")),
					input,
				),
			),
		);
	});

	app.get("/my-interviews", async (c) => {
		const group = panelistRoundGroupSchema
			.optional()
			.safeParse(c.req.query("group"));
		if (!group.success) throw new InterviewProblem(400, "invalid_input");
		const result = await listAssignedRounds(
			database,
			c.get("staff").id,
			currentTime(config),
			pageNumber(c.req.query("page")),
			group.data,
		);
		return c.json(assignedInterviewsSchema.parse(result));
	});

	app.get("/my-interviews/dashboard", async (c) =>
		c.json(
			panelistDashboardSchema.parse(
				await getPanelistDashboard(
					database,
					c.get("staff").id,
					currentTime(config),
				),
			),
		),
	);

	app.get("/my-interviews/invitations/:id", async (c) =>
		c.json(
			interviewResultSchema.parse(
				await resolveStaffInvite(
					database,
					uuidParam(c.req.param("id")),
					c.get("staff").id,
				),
			),
		),
	);
	app.get("/my-interviews/:id", async (c) =>
		c.json(
			assignedInterviewSchema.parse(
				await getAssignedRound(
					database,
					uuidParam(c.req.param("id")),
					c.get("staff").id,
					currentTime(config),
				),
			),
		),
	);
	app.post("/my-interviews/:id/commands", smallBody, async (c) => {
		const input = await readBody(c, interviewCommandSchema);
		if (input.action !== "start" && input.action !== "end")
			throw new InterviewProblem(409, "invalid_transition");
		const result = await changeRound(
			database,
			config,
			c.get("staff").id,
			"panelist",
			uuidParam(c.req.param("id")),
			input,
		);
		logger.info(
			{
				stage:
					input.action === "start" ? "interview_started" : "interview_closed",
			},
			"Interview lifecycle",
		);
		return c.json(interviewResultSchema.parse(result));
	});
	app.get("/my-interviews/:id/assessment", async (c) => {
		const known = c.req.header("If-None-Match");
		const view = await getAssignedAssessment(
			database,
			config,
			c.get("staff").id,
			uuidParam(c.req.param("id")),
			known,
		);
		c.header("ETag", view?.revisionTag ?? known);
		return view ? c.json(assessmentViewSchema.parse(view)) : c.body(null, 304);
	});
	app.post("/my-interviews/:id/assessment/initialize", smallBody, async (c) =>
		c.json(
			interviewResultSchema.parse(
				await changeAssessment(
					database,
					config,
					c.get("staff").id,
					uuidParam(c.req.param("id")),
					{
						action: "initialize",
						...(await readBody(c, initializeAssessmentSchema)),
					},
				),
			),
		),
	);
	app.patch("/my-interviews/:id/assessment/draft", assessmentBody, async (c) =>
		c.json(
			interviewResultSchema.parse(
				await changeAssessment(
					database,
					config,
					c.get("staff").id,
					uuidParam(c.req.param("id")),
					{
						action: "draft",
						...(await readBody(c, saveAssessmentDraftSchema)),
					},
				),
			),
		),
	);
	app.post("/my-interviews/:id/assessment/submit", smallBody, async (c) =>
		c.json(
			interviewResultSchema.parse(
				await changeAssessment(
					database,
					config,
					c.get("staff").id,
					uuidParam(c.req.param("id")),
					{ action: "submit", ...(await readBody(c, submitAssessmentSchema)) },
				),
			),
		),
	);
	app.post("/my-interviews/:id/assessment/correct", assessmentBody, async (c) =>
		c.json(
			interviewResultSchema.parse(
				await correctAssessment(
					database,
					config,
					c.get("staff").id,
					uuidParam(c.req.param("id")),
					await readBody(c, correctAssessmentSchema),
				),
			),
		),
	);
	for (const [prefix, role] of [
		["/interviews", "hr"],
		["/my-interviews", "panelist"],
	] as const) {
		app.get(`${prefix}/:id/assessment/versions`, async (c) =>
			c.json(
				assessmentVersionListSchema.parse(
					await listAssessmentVersions(
						database,
						config,
						c.get("staff").id,
						role,
						uuidParam(c.req.param("id")),
						pageNumber(c.req.query("page")),
					),
				),
			),
		);
		app.get(`${prefix}/:id/assessment/versions/:versionId`, async (c) =>
			c.json(
				assessmentVersionDetailSchema.parse(
					await getAssessmentVersion(
						database,
						config,
						c.get("staff").id,
						role,
						uuidParam(c.req.param("id")),
						uuidParam(c.req.param("versionId")),
					),
				),
			),
		);
	}
	return app;
}
