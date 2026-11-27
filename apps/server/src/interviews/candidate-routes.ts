import { getConnInfo } from "@hono/node-server/conninfo";
import {
	artifactHeadSchema,
	artifactSnapshotSchema,
	candidateEndSchema,
	candidateInterviewSchema,
	codeRunOutputSchema,
	codeRunSummarySchema,
	confirmInterviewProfileSchema,
	interviewChallengeSchema,
	interviewCompleteSchema,
	interviewResultSchema,
	requestInterviewCodeSchema,
	verifyInterviewCodeSchema,
	workspaceBindingHeader,
	workspaceDescriptorSchema,
} from "@studio/contracts";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { getCookie, setCookie } from "hono/cookie";
import type { PgBoss } from "pg-boss";
import { logger } from "../logger.ts";
import type { StaffSettings } from "../staff/settings.ts";
import {
	candidateRound,
	limitPublicRequests,
	requestCode,
	verifyCode,
} from "./admission.ts";
import { interviewClientAddress } from "./client-address.ts";
import { artifactKind, readArtifactBody, readBody, uuidParam } from "./http.ts";
import { InterviewProblem } from "./problem.ts";
import type { Database, InterviewConfig } from "./store.ts";

import {
	readCandidateWorkspace,
	saveCandidateArtifact,
	submitCandidateCodeRun,
} from "./workspace.ts";

import type { WorkspaceLive } from "./workspace-live.ts";
import { createWorkspaceSaveGate } from "./workspace-save-gate.ts";

const cookie = "studio-candidate";

export function interviewCandidateRoutes(
	database: Database,
	config: InterviewConfig,
	settings: Pick<StaffSettings, "trustedOrigins" | "secureCookies">,
	mail: Parameters<typeof requestCode>[2],
	live?: WorkspaceLive,
	boss?: Pick<PgBoss, "send">,
) {
	const app = new Hono();
	const withSaveSlot = createWorkspaceSaveGate();
	const smallBody = bodyLimit({ maxSize: 2_048 });
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
	app.post("/invitations/:id/code", smallBody, async (c) => {
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
	app.post("/invitations/:id/verify", smallBody, async (c) => {
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
	app.post("/rounds/:id/profile", smallBody, async (c) =>
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
	app.post("/rounds/:id/presence", smallBody, async (c) =>
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
	app.post("/rounds/:id/end", smallBody, async (c) => {
		const result = await candidateRound(
			database,
			config,
			uuidParam(c.req.param("id")),
			getCookie(c, cookie),
			{
				action: "end",
				...(await readBody(c, candidateEndSchema)),
				binding: c.req.header(workspaceBindingHeader),
			},
		);
		logger.info({ stage: "interview_closed" }, "Interview lifecycle");
		return c.json(interviewCompleteSchema.parse(result));
	});
	if (live)
		app.get("/rounds/:id/live", async (c, next) => {
			const id = uuidParam(c.req.param("id"));
			const token = getCookie(c, cookie);
			return live.open(c, next, settings.trustedOrigins, id, async (binding) =>
				workspaceDescriptorSchema.parse(
					await readCandidateWorkspace(
						database,
						config,
						id,
						token,
						undefined,
						binding,
					),
				),
			);
		});
	app.get("/rounds/:id/workspace", async (c) =>
		c.json(
			workspaceDescriptorSchema.parse(
				await readCandidateWorkspace(
					database,
					config,
					uuidParam(c.req.param("id")),
					getCookie(c, cookie),
					undefined,
					c.req.header(workspaceBindingHeader),
					{},
				),
			),
		),
	);
	app.get("/rounds/:id/workspace/runs/:runId", async (c) =>
		c.json(
			codeRunOutputSchema.parse(
				await readCandidateWorkspace(
					database,
					config,
					uuidParam(c.req.param("id")),
					getCookie(c, cookie),
					undefined,
					c.req.header(workspaceBindingHeader),
					{ runId: uuidParam(c.req.param("runId")) },
				),
			),
		),
	);
	app.post("/rounds/:id/workspace/runs", async (c) => {
		const id = uuidParam(c.req.param("id"));
		const token = getCookie(c, cookie);
		const result = await withSaveSlot(token, `${id}:run`, async () =>
			submitCandidateCodeRun(
				database,
				config,
				boss,
				id,
				token,
				c.req.header(workspaceBindingHeader),
				await readArtifactBody(c, "code", 448 * 1024),
			),
		);
		return c.json(codeRunSummarySchema.parse(result));
	});
	app.get("/rounds/:id/workspace/:kind", async (c) => {
		const kind = artifactKind(c.req.param("kind"));
		return c.json(
			artifactSnapshotSchema(kind).parse(
				await readCandidateWorkspace(
					database,
					config,
					uuidParam(c.req.param("id")),
					getCookie(c, cookie),
					kind,
					c.req.header(workspaceBindingHeader),
				),
			),
		);
	});
	app.post("/rounds/:id/workspace/:kind", async (c) => {
		const kind = artifactKind(c.req.param("kind"));
		const id = uuidParam(c.req.param("id"));
		const token = getCookie(c, cookie);
		const result = await withSaveSlot(token, `${id}:${kind}`, async () =>
			saveCandidateArtifact(
				database,
				config,
				id,
				token,
				kind,
				c.req.header(workspaceBindingHeader),
				await readArtifactBody(c, kind),
			),
		);
		return c.json(artifactHeadSchema.parse(result));
	});
	return app;
}
