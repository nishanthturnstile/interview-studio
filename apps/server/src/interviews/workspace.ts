import {
	type ArtifactHead,
	type ArtifactKind,
	artifactSchemaVersion,
	codeLanguages,
	codeRunRequestSchema,
	emptyArtifactHead,
	emptyArtifacts,
	type WorkspaceHeadIds,
	workspaceBindingSchema,
	workspacePayloadSchemas,
	workspaceSaveSchema,
} from "@studio/contracts";
import { and, eq, isNotNull, sql } from "drizzle-orm";
import type { PgBoss } from "pg-boss";
import { session as staffSession, user } from "../staff/auth-schema.ts";
import { staffGrant } from "../staff/role-schema.ts";
import {
	type StaffSessionIdentity,
	staffSessionUnexpired,
} from "../staff/session-access.ts";
import { isApprovedEmail } from "../staff/settings.ts";
import {
	candidateIdentity,
	candidateToken,
	candidateUnavailable,
	lockCandidateRound,
	requireCurrentCandidate,
} from "./candidate-access.ts";
import { latestCodeRun, queueCodeRun, readCodeRun } from "./code-runs.ts";
import { InterviewProblem } from "./problem.ts";
import {
	interviewArtifactHead as head,
	interviewRound,
	interviewArtifactRevision as revision,
} from "./schema.ts";
import {
	commandReceipt,
	currentTime,
	type Database,
	type InterviewConfig,
	sameDigest,
	sign,
	type Transaction,
} from "./store.ts";
import { notifyWorkspace } from "./workspace-signals.ts";

const metadata = { sequence: revision.sequence, revisionId: revision.id };
function headJoin(
	roundId: string | typeof interviewRound.id,
	kind?: ArtifactKind,
) {
	return and(eq(head.roundId, roundId), kind ? eq(head.kind, kind) : undefined);
}

const revisionJoin = and(
	eq(revision.roundId, head.roundId),
	eq(revision.kind, head.kind),
	eq(revision.id, head.revisionId),
);

function artifactRows(
	db: Database | Transaction,
	id: string,
	kind?: ArtifactKind,
	withPayload = false,
) {
	return db
		.select({
			kind: head.kind,
			...metadata,
			...(withPayload
				? { schemaVersion: revision.schemaVersion, payload: revision.payload }
				: {}),
		})
		.from(head)
		.innerJoin(revision, revisionJoin)
		.where(headJoin(id, kind));
}

function workspaceBinding(
	config: InterviewConfig,
	actor: "candidate" | "staff",
	id: string,
	sessionId: string,
) {
	return sign(config.key, "workspace-session", actor, id, sessionId);
}

function requireBinding(expected: string, provided: string | undefined) {
	if (!provided) throw new InterviewProblem(409, "workspace_refresh_required");
	if (
		!workspaceBindingSchema.safeParse(provided).success ||
		!sameDigest(expected, provided)
	)
		throw new InterviewProblem(403, "workspace_binding_changed");
}

type ArtifactRow = {
	kind: ArtifactKind | null;
	sequence: number | null;
	revisionId: string | null;
	schemaVersion?: number | null;
	payload?: unknown;
};

function describeHeads(rows: ArtifactRow[]) {
	const heads: Record<ArtifactKind, ArtifactHead> = {
		code: emptyArtifactHead,
		board: emptyArtifactHead,
	};
	for (const row of rows) {
		if (row.kind && row.sequence !== null)
			heads[row.kind] = { sequence: row.sequence, revisionId: row.revisionId };
	}
	return heads;
}

function readResponse(
	rows: ArtifactRow[],
	active: boolean,
	binding: string,
	kind?: ArtifactKind,
) {
	if (!kind) return { active, binding, heads: describeHeads(rows) };
	const row = rows.find((item) => item.kind === kind);
	return row
		? {
				sequence: row.sequence,
				revisionId: row.revisionId,
				schemaVersion: row.schemaVersion,
				payload: row.payload,
			}
		: {
				...emptyArtifactHead,
				schemaVersion: artifactSchemaVersion,
				payload:
					active && kind === "code"
						? {
								...emptyArtifacts.code,
								source: codeLanguages.javascript.starter,
							}
						: emptyArtifacts[kind],
			};
}

function requireWorkspaceCandidate(
	config: InterviewConfig,
	access: Awaited<ReturnType<typeof lockCandidateRound>>,
) {
	requireCurrentCandidate(config, access);
	if (!access.session.confirmedAt || access.round.state !== "active")
		throw candidateUnavailable();
}

export function readCandidateWorkspace(
	database: Database,
	config: InterviewConfig,
	id: string,
	token: string | undefined,
	kind?: ArtifactKind,
	providedBinding?: string,
	execution?: { runId?: string },
) {
	const tokenHash = candidateToken(token);
	return database.transaction(
		async (tx) => {
			const [round] = await tx
				.select()
				.from(interviewRound)
				.where(eq(interviewRound.id, id));
			const [identity] = await candidateIdentity(tx, id, tokenHash);
			if (!round || !identity) throw candidateUnavailable();
			requireWorkspaceCandidate(config, { round, ...identity });
			const binding = workspaceBinding(
				config,
				"candidate",
				id,
				identity.session.id,
			);
			if (kind || execution?.runId || providedBinding !== undefined)
				requireBinding(binding, providedBinding);
			if (execution?.runId)
				return { ...(await readCodeRun(tx, id, execution.runId)), binding };
			const response = readResponse(
				await artifactRows(tx, id, kind, kind !== undefined),
				true,
				binding,
				kind,
			);
			return execution
				? {
						...response,
						executionEnabled: Boolean(
							config.codeExecutionEnabled && round.codeExecutionEnabled,
						),
						latestRun: await latestCodeRun(tx, id),
					}
				: response;
		},
		{ isolationLevel: "repeatable read", accessMode: "read only" },
	);
}

export function staffWorkspaceAccess(
	db: Database | Transaction,
	identity: StaffSessionIdentity,
	id: string,
) {
	return db
		.select({
			roundId: interviewRound.id,
			state: interviewRound.state,
			meeting: interviewRound.meeting,
			email: user.email,
		})
		.from(interviewRound)
		.innerJoin(
			user,
			and(
				eq(user.id, identity.userId),
				eq(user.id, interviewRound.panelistId),
				eq(user.emailVerified, true),
			),
		)
		.innerJoin(
			staffSession,
			and(
				eq(staffSession.userId, user.id),
				eq(staffSession.id, identity.sessionId),
				staffSessionUnexpired,
			),
		)
		.leftJoin(staffGrant, eq(staffGrant.userId, user.id))
		.where(
			and(
				eq(interviewRound.id, id),
				isNotNull(interviewRound.startedAt),
				sql`coalesce(${staffGrant.role}, 'panelist') = 'panelist'`,
			),
		);
}

export async function readStaffWorkspace(
	database: Database,
	config: InterviewConfig,
	id: string,
	identity: StaffSessionIdentity,
	kind?: ArtifactKind,
	providedBinding?: string,
	execution?: { runId?: string },
) {
	return database.transaction(
		async (tx) => {
			const access = staffWorkspaceAccess(tx, identity, id).as(
				"workspace_access",
			);
			const rows = await tx
				.select({
					email: access.email,
					state: access.state,
					kind: head.kind,
					...metadata,
					...(kind
						? {
								schemaVersion: revision.schemaVersion,
								payload: revision.payload,
							}
						: {}),
				})
				.from(access)
				.leftJoin(
					head,
					and(
						eq(head.roundId, access.roundId),
						kind ? eq(head.kind, kind) : undefined,
					),
				)
				.leftJoin(revision, revisionJoin);
			const first = rows[0];
			if (!first || !isApprovedEmail(first.email, config.domains))
				throw new InterviewProblem(404, "not_found");
			const binding = workspaceBinding(config, "staff", id, identity.sessionId);
			if (kind || execution?.runId || providedBinding !== undefined)
				requireBinding(binding, providedBinding);
			if (execution?.runId)
				return { ...(await readCodeRun(tx, id, execution.runId)), binding };
			const response = readResponse(
				rows,
				first.state === "active",
				binding,
				kind,
			);
			return execution
				? {
						...response,
						latestRun: await latestCodeRun(tx, id),
					}
				: response;
		},
		{ isolationLevel: "repeatable read", accessMode: "read only" },
	);
}

export function submitCandidateCodeRun(
	database: Database,
	config: InterviewConfig,
	boss: Pick<PgBoss, "send"> | undefined,
	id: string,
	token: string | undefined,
	providedBinding: string | undefined,
	body: unknown,
) {
	const tokenHash = candidateToken(token);
	return database.transaction(async (tx) => {
		const access = await lockCandidateRound(tx, id, tokenHash);
		requireWorkspaceCandidate(config, access);
		requireBinding(
			workspaceBinding(config, "candidate", id, access.session.id),
			providedBinding,
		);
		const command = codeRunRequestSchema.safeParse(body);
		if (!command.success)
			throw new InterviewProblem(422, "workspace_invalid", {
				kind: "code",
				field: command.error.issues[0]?.path.join("."),
			});
		if (!boss) throw new InterviewProblem(503, "code_run_unavailable");
		return queueCodeRun(
			tx,
			boss,
			id,
			Boolean(config.codeExecutionEnabled && access.round.codeExecutionEnabled),
			command.data,
		);
	});
}

export function saveCandidateArtifact(
	database: Database,
	config: InterviewConfig,
	id: string,
	token: string | undefined,
	kind: ArtifactKind,
	providedBinding: string | undefined,
	body: unknown,
) {
	const tokenHash = candidateToken(token);
	return database.transaction(async (tx) => {
		const access = await lockCandidateRound(tx, id, tokenHash);
		requireWorkspaceCandidate(config, access);
		requireBinding(
			workspaceBinding(config, "candidate", id, access.session.id),
			providedBinding,
		);

		const command = workspaceSaveSchema.safeParse(body);
		if (!command.success)
			throw new InterviewProblem(400, "workspace_invalid", {
				kind,
				field: command.error.issues[0]?.path.join("."),
			});
		const payload = workspacePayloadSchemas[kind].safeParse(
			command.data.payload,
		);
		if (!payload.success)
			throw new InterviewProblem(422, "workspace_invalid", {
				kind,
				field: payload.error.issues[0]?.path.join("."),
			});

		const input = {
			commandId: command.data.commandId,
			baseSequence: command.data.baseSequence,
			payload: payload.data,
		};
		const receipt = await commandReceipt(
			tx,
			config,
			{ actor: "candidate", actorId: access.session.id },
			input,
			`artifact:${id}:${kind}`,
		);
		if (receipt.previous) {
			if (!receipt.matches)
				throw new InterviewProblem(409, "idempotency_conflict");
			const [saved] = await tx
				.select(metadata)
				.from(revision)
				.where(eq(revision.id, receipt.previous.resourceId));
			if (!saved) throw new Error("Artifact receipt has no revision");
			return saved;
		}

		const current = describeHeads(await artifactRows(tx, id, kind))[kind];
		if (current.sequence !== input.baseSequence)
			throw new InterviewProblem(409, "workspace_conflict", {
				kind,
				head: current,
			});
		const [saved] = await tx
			.insert(revision)
			.values({
				roundId: id,
				kind,
				sequence: current.sequence + 1,
				schemaVersion: artifactSchemaVersion,
				payload: input.payload,
				authorSessionId: access.session.id,
				savedAt: currentTime(config),
			})
			.returning(metadata);
		await tx
			.insert(head)
			.values({ roundId: id, kind, revisionId: saved.revisionId })
			.onConflictDoUpdate({
				target: [head.roundId, head.kind],
				set: { revisionId: saved.revisionId },
			});
		await receipt.record(saved.revisionId);
		await notifyWorkspace(tx, { roundId: id, kind, sequence: saved.sequence });
		return saved;
	});
}

export function requireCandidateCloseBinding(
	config: InterviewConfig,
	id: string,
	sessionId: string,
	input: { expectedHeads?: WorkspaceHeadIds; binding?: string },
) {
	requireBinding(
		workspaceBinding(config, "candidate", id, sessionId),
		input.binding,
	);
	if (!input.expectedHeads)
		throw new InterviewProblem(409, "workspace_refresh_required");
	return input.expectedHeads;
}

export async function requireCandidateCloseHeads(
	tx: Transaction,
	id: string,
	expectedHeads: WorkspaceHeadIds,
) {
	const heads = describeHeads(await artifactRows(tx, id));
	for (const kind of ["code", "board"] as const) {
		if (heads[kind].revisionId !== expectedHeads[kind])
			throw new InterviewProblem(409, "workspace_conflict", {
				kind,
				head: heads[kind],
			});
	}
}
