import {
	assignedInterviewSchema,
	assignedInterviewsSchema,
	bookInterviewSchema,
	canManageInterviews,
	canViewAssignedInterviews,
	hrInterviewSchema,
	interviewCommandSchema,
	interviewInvitationSchema,
	interviewListQuerySchema,
	interviewPageNumberSchema,
	interviewPanelistsSchema,
	interviewPreferencesSchema,
	interviewResultSchema,
	interviewSlotPreviewSchema,
	interviewSlotSchema,
	type StaffIdentity,
	withdrawCandidacySchema,
} from "@studio/contracts";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { logger } from "../logger.ts";
import { readBody, uuidParam } from "./http.ts";
import { InterviewProblem } from "./problem.ts";
import {
	findPanelists,
	getAssignedRound,
	getHrRound,
	listAssignedRounds,
	listInterviews,
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

export function interviewStaffRoutes(
	database: Database,
	config: InterviewConfig,
) {
	const app = new Hono<{ Variables: { staff: StaffIdentity } }>();
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
		app.use(path, bodyLimit({ maxSize: 4_096 }));
	}

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
	app.patch("/settings/interviews", async (c) =>
		c.json(
			interviewPreferencesSchema.parse(
				await savePreferences(
					database,
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
			await listInterviews(database, query.data, currentTime(config)),
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
	app.post("/interviews", async (c) => {
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
	app.post(
		"/interviews/candidacies/:driveId/:candidateId/withdraw",
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
	app.get("/interviews/:id", async (c) =>
		c.json(
			hrInterviewSchema.parse(
				await getHrRound(
					database,
					uuidParam(c.req.param("id")),
					currentTime(config),
				),
			),
		),
	);
	app.get("/interviews/:id/invitation", async (c) =>
		c.json(
			interviewInvitationSchema.parse(
				await copyInvitation(database, config, uuidParam(c.req.param("id"))),
			),
		),
	);
	app.post("/interviews/:id/commands", async (c) => {
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
		const page = interviewPageNumberSchema
			.default(1)
			.safeParse(c.req.query("page"));
		if (!page.success) throw new InterviewProblem(400, "invalid_input");
		const result = await listAssignedRounds(
			database,
			c.get("staff").id,
			currentTime(config),
			page.data,
		);
		return c.json(assignedInterviewsSchema.parse(result));
	});

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
	app.post("/my-interviews/:id/commands", async (c) => {
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
	return app;
}
