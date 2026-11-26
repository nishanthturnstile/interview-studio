import { getConnInfo } from "@hono/node-server/conninfo";
import {
	candidateEndSchema,
	candidateInterviewSchema,
	confirmInterviewProfileSchema,
	interviewChallengeSchema,
	interviewCompleteSchema,
	interviewResultSchema,
	requestInterviewCodeSchema,
	verifyInterviewCodeSchema,
} from "@studio/contracts";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { getCookie, setCookie } from "hono/cookie";
import { logger } from "../logger.ts";
import type { StaffSettings } from "../staff/settings.ts";
import {
	candidateRound,
	limitPublicRequests,
	requestCode,
	verifyCode,
} from "./admission.ts";
import { interviewClientAddress } from "./client-address.ts";
import { readBody, uuidParam } from "./http.ts";
import { InterviewProblem } from "./problem.ts";
import type { Database, InterviewConfig } from "./store.ts";

const cookie = "studio-candidate";

export function interviewCandidateRoutes(
	database: Database,
	config: InterviewConfig,
	settings: Pick<StaffSettings, "trustedOrigins" | "secureCookies">,
	mail: Parameters<typeof requestCode>[2],
) {
	const app = new Hono();
	app.use("*", bodyLimit({ maxSize: 2_048 }));
	app.use("*", async (c, next) => {
		c.header("Cache-Control", "no-store");
		c.header("Referrer-Policy", "no-referrer");
		if (
			c.req.method !== "GET" &&
			!settings.trustedOrigins.includes(c.req.header("origin") ?? "")
		) {
			throw new InterviewProblem(403, "untrusted_origin");
		}
		await next();
	});
	app.use("/invitations/*", async (c, next) => {
		if (c.req.method !== "POST") return c.notFound();
		const source = interviewClientAddress(
			getConnInfo(c).remote.address,
			c.req.header("X-Studio-Client-IP"),
			config.trustedProxies,
		);
		const action = c.req.path.endsWith("/verify") ? "verify" : "send";
		await limitPublicRequests(database, config, source, action);
		await next();
	});
	app.post("/invitations/:id/code", async (c) => {
		const result = await requestCode(
			database,
			config,
			mail,
			uuidParam(c.req.param("id")),
			await readBody(c, requestInterviewCodeSchema),
		);
		logger.info({ stage: "interview_code_sent" }, "Interview admission");
		return c.json(interviewChallengeSchema.parse(result));
	});
	app.post("/invitations/:id/verify", async (c) => {
		const verified = await verifyCode(
			database,
			config,
			uuidParam(c.req.param("id")),
			await readBody(c, verifyInterviewCodeSchema),
		);
		setCookie(c, cookie, verified.token, {
			path: `/api/interviews/rounds/${verified.id}`,
			httpOnly: true,
			sameSite: "Strict",
			secure: settings.secureCookies,
		});
		logger.info({ stage: "interview_admitted" }, "Interview admission");
		return c.json(interviewResultSchema.parse(verified));
	});
	app.get("/rounds/:id", async (c) =>
		c.json(
			candidateInterviewSchema.parse(
				await candidateRound(
					database,
					config,
					uuidParam(c.req.param("id")),
					getCookie(c, cookie),
					{ action: "read" },
				),
			),
		),
	);
	app.post("/rounds/:id/profile", async (c) =>
		c.json(
			candidateInterviewSchema.parse(
				await candidateRound(
					database,
					config,
					uuidParam(c.req.param("id")),
					getCookie(c, cookie),
					{
						action: "confirm",
						...(await readBody(c, confirmInterviewProfileSchema)),
					},
				),
			),
		),
	);
	app.post("/rounds/:id/presence", async (c) =>
		c.json(
			candidateInterviewSchema.parse(
				await candidateRound(
					database,
					config,
					uuidParam(c.req.param("id")),
					getCookie(c, cookie),
					{ action: "presence" },
				),
			),
		),
	);
	app.post("/rounds/:id/end", async (c) => {
		const result = await candidateRound(
			database,
			config,
			uuidParam(c.req.param("id")),
			getCookie(c, cookie),
			{ action: "end", ...(await readBody(c, candidateEndSchema)) },
		);
		logger.info({ stage: "interview_closed" }, "Interview lifecycle");
		return c.json(interviewCompleteSchema.parse(result));
	});
	return app;
}
