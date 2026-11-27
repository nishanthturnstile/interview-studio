import {
	type ArtifactPayload,
	type AssessmentCriteria,
	type AssessmentDraft,
	type AssessmentScorecard,
	artifactKindSchema,
	codeLanguageSchema,
	codeRunStateSchema,
	type FeedbackResolutionOutcome,
	feedbackResolutionActionSchema,
	feedbackReviewKindSchema,
	type InterviewMeeting,
	interviewStateSchema,
	noShowPartySchema,
} from "@studio/contracts";
import { sql } from "drizzle-orm";
import {
	type AnyPgColumn,
	boolean,
	check,
	foreignKey,
	index,
	integer,
	jsonb,
	type PgTableExtraConfigValue,
	pgEnum,
	pgTable,
	primaryKey,
	text,
	timestamp,
	unique,
	uniqueIndex,
	uuid,
} from "drizzle-orm/pg-core";
import { driveCandidate, round } from "../drives/schema.ts";
import { user } from "../staff/auth-schema.ts";

const when = (name: string) => timestamp(name, { withTimezone: true });
export const interviewState = pgEnum(
	"interview_state",
	interviewStateSchema.enum,
);
export const noShowParty = pgEnum(
	"interview_absent_party",
	noShowPartySchema.enum,
);
export const challengePhase = pgEnum("interview_challenge_phase", [
	"pending",
	"sent",
	"failed",
]);
export const feedbackReviewKind = pgEnum(
	"interview_feedback_review_kind",
	feedbackReviewKindSchema.enum,
);
export const feedbackResolutionAction = pgEnum(
	"interview_feedback_resolution_action",
	feedbackResolutionActionSchema.enum,
);
export const interviewCodeLanguage = pgEnum(
	"interview_code_language",
	codeLanguageSchema.enum,
);
export const interviewCodeRunState = pgEnum(
	"interview_code_run_state",
	codeRunStateSchema.enum,
);

export const interviewPreference = pgTable(
	"interview_preference",
	{
		staffId: text("staff_id")
			.primaryKey()
			.references(() => user.id),
		timeZone: text("time_zone").notNull(),
		duration: integer().notNull(),
		revision: integer().notNull(),
	},
	(t) => [
		check(
			"interview_preference_duration",
			sql`${t.duration} between 5 and 480`,
		),
	],
);

export const interviewRound = pgTable(
	"interview_round",
	{
		id: uuid().primaryKey().defaultRandom(),
		driveId: uuid("drive_id").notNull(),
		candidateId: uuid("candidate_id").notNull(),
		level: round().notNull(),
		attempt: integer().notNull(),
		panelistId: text("panelist_id")
			.notNull()
			.references(() => user.id),
		invitedEmail: text("invited_email").notNull(),
		candidateName: text("candidate_name").notNull(),
		experienceTenths: integer("experience_tenths"),
		start: when("starts_at").notNull(),
		end: when("ends_at").notNull(),
		timeZone: text("time_zone").notNull(),
		duration: integer().notNull(),
		meeting: jsonb().$type<InterviewMeeting>().notNull(),
		state: interviewState().notNull().default("scheduled"),
		revision: integer().notNull().default(0),
		createdBy: text("created_by")
			.notNull()
			.references(() => user.id),
		createdAt: when("created_at").notNull().defaultNow(),
		startedBy: text("started_by").references(() => user.id),
		startedAt: when("started_at"),
		closedAt: when("closed_at"),
		cancelledAt: when("cancelled_at"),
		cancellationCode: text("cancellation_code").$type<
			"panelist_unavailable" | "l1_pass_reversed"
		>(),
		legacyAssessment: boolean("legacy_assessment").notNull().default(false),
		codeExecutionEnabled: boolean("code_execution_enabled")
			.notNull()
			.default(false),
		qualifyingL1RoundId: uuid("qualifying_l1_round_id"),
		qualifyingL1VersionId: uuid("qualifying_l1_version_id"),
		reason: text(),
		absent: noShowParty(),
	},
	(t): PgTableExtraConfigValue[] => [
		foreignKey({
			name: "interview_round_candidacy_fk",
			columns: [t.driveId, t.candidateId],
			foreignColumns: [driveCandidate.driveId, driveCandidate.id],
		}),
		unique("interview_round_attempt").on(
			t.driveId,
			t.candidateId,
			t.level,
			t.attempt,
		),
		unique("interview_round_scope").on(t.driveId, t.candidateId, t.id),
		foreignKey({
			name: "interview_round_qualifying_l1_candidacy_fk",
			columns: [t.driveId, t.candidateId, t.qualifyingL1RoundId],
			foreignColumns: [t.driveId, t.candidateId, t.id] as [
				AnyPgColumn,
				AnyPgColumn,
				AnyPgColumn,
			],
		}),
		foreignKey({
			name: "interview_round_qualifying_l1_version_fk",
			columns: [t.qualifyingL1RoundId, t.qualifyingL1VersionId],
			foreignColumns: [
				interviewAssessmentVersion.roundId,
				interviewAssessmentVersion.id,
			] as [AnyPgColumn, AnyPgColumn],
		}),
		check(
			"interview_round_l1_qualification",
			sql`(${t.qualifyingL1RoundId} is null and ${t.qualifyingL1VersionId} is null) or (${t.level} = 'l2' and ${t.qualifyingL1RoundId} is not null and ${t.qualifyingL1VersionId} is not null)`,
		),
		uniqueIndex("interview_round_unresolved")
			.on(t.driveId, t.candidateId)
			.where(sql`${t.state} in ('scheduled', 'active', 'awaiting_feedback')`),
		index("interview_round_panelist_time").on(t.panelistId, t.start, t.end),
		index("interview_round_email_time").on(t.invitedEmail, t.start, t.end),
		check(
			"interview_round_slot",
			sql`${t.duration} between 5 and 480 and ${t.end} = ${t.start} + ${t.duration} * interval '1 minute'`,
		),
		check("interview_round_attempt_positive", sql`${t.attempt} > 0`),
	],
);

export const interviewCodeRun = pgTable(
	"interview_code_run",
	{
		id: uuid().primaryKey().defaultRandom(),
		roundId: uuid("round_id")
			.notNull()
			.references(() => interviewRound.id),
		commandId: uuid("command_id").notNull(),
		language: interviewCodeLanguage().notNull(),
		source: text().notNull(),
		input: text().notNull(),
		digest: text().notNull(),
		inputDigest: text("input_digest").notNull(),
		state: interviewCodeRunState().notNull().default("queued"),
		stdout: text().notNull().default(""),
		stderr: text().notNull().default(""),
		createdAt: when("created_at").notNull().default(sql`clock_timestamp()`),
		startedAt: when("started_at"),
	},
	(t) => [
		unique("interview_code_run_command").on(t.roundId, t.commandId),
		uniqueIndex("interview_code_run_unfinished")
			.on(t.roundId)
			.where(sql`${t.state} in ('queued', 'running')`),
		index("interview_code_run_latest").on(
			t.roundId,
			t.createdAt.desc(),
			t.id.desc(),
		),
	],
);

export const interviewAssessment = pgTable("interview_assessment", {
	roundId: uuid("round_id")
		.primaryKey()
		.references(() => interviewRound.id),
	criteria: jsonb().$type<AssessmentCriteria>().notNull(),
	draft: jsonb().$type<AssessmentDraft>().notNull().default({
		questions: [],
		notes: "",
		ratings: [],
		decision: null,
		rationale: "",
	}),
	draftRevision: integer("draft_revision").notNull().default(0),
	draftUpdatedAt: when("draft_updated_at"),
});

export const interviewAssessmentVersion = pgTable(
	"interview_assessment_version",
	{
		id: uuid().primaryKey().defaultRandom(),
		roundId: uuid("round_id")
			.notNull()
			.references(() => interviewAssessment.roundId),
		version: integer().notNull(),
		previousVersionId: uuid("previous_version_id"),
		reviewedL1VersionId: uuid("reviewed_l1_version_id").references(
			(): AnyPgColumn => interviewAssessmentVersion.id,
		),
		decision: text().$type<AssessmentScorecard["decision"]>().notNull(),
		ratings: jsonb().$type<AssessmentScorecard["ratings"]>().notNull(),
		rationale: text().notNull(),
		correctionReason: text("correction_reason"),
		authorId: text("author_id")
			.notNull()
			.references(() => user.id),
		submittedAt: when("submitted_at").notNull(),
	},
	(t) => [
		unique("interview_assessment_version_number").on(t.roundId, t.version),
		unique("interview_assessment_version_scope").on(t.roundId, t.id),
		foreignKey({
			name: "interview_assessment_previous_version_fk",
			columns: [t.roundId, t.previousVersionId],
			foreignColumns: [t.roundId, t.id] as [AnyPgColumn, AnyPgColumn],
		}),
		check(
			"interview_assessment_version_chain",
			sql`(${t.version} = 1 and ${t.previousVersionId} is null and ${t.correctionReason} is null) or (${t.version} > 1 and ${t.previousVersionId} is not null and length(btrim(${t.correctionReason})) > 0 and ${t.correctionReason} is not null)`,
		),
	],
);

export const interviewProgress = pgTable(
	"interview_progress",
	{
		driveId: uuid("drive_id").notNull(),
		candidateId: uuid("candidate_id").notNull(),
		l1VersionId: uuid("l1_version_id").references(
			() => interviewAssessmentVersion.id,
		),
		currentL2RoundId: uuid("current_l2_round_id"),
		revision: integer().notNull(),
	},
	(t) => [
		primaryKey({ columns: [t.driveId, t.candidateId] }),
		foreignKey({
			name: "interview_progress_candidacy_fk",
			columns: [t.driveId, t.candidateId],
			foreignColumns: [driveCandidate.driveId, driveCandidate.id],
		}),
		foreignKey({
			name: "interview_progress_current_l2_fk",
			columns: [t.driveId, t.candidateId, t.currentL2RoundId],
			foreignColumns: [
				interviewRound.driveId,
				interviewRound.candidateId,
				interviewRound.id,
			],
		}),
	],
);

export const interviewWithdrawal = pgTable(
	"interview_withdrawal",
	{
		driveId: uuid("drive_id").notNull(),
		candidateId: uuid("candidate_id").notNull(),
		staffId: text("staff_id")
			.notNull()
			.references(() => user.id),
		createdAt: when("created_at").notNull().defaultNow(),
		reason: text().notNull(),
	},
	(t) => [
		primaryKey({ columns: [t.driveId, t.candidateId] }),
		foreignKey({
			name: "interview_withdrawal_candidacy_fk",
			columns: [t.driveId, t.candidateId],
			foreignColumns: [driveCandidate.driveId, driveCandidate.id],
		}),
	],
);

export const interviewFeedbackReview = pgTable(
	"interview_feedback_review",
	{
		id: uuid().primaryKey().defaultRandom(),
		driveId: uuid("drive_id").notNull(),
		candidateId: uuid("candidate_id").notNull(),
		kind: feedbackReviewKind().notNull(),
		l1RoundId: uuid("l1_round_id").notNull(),
		previousL1VersionId: uuid("previous_l1_version_id").notNull(),
		triggerL1VersionId: uuid("trigger_l1_version_id").notNull().unique(),
		affectedL2RoundId: uuid("affected_l2_round_id").notNull(),
		affectedL2VersionId: uuid("affected_l2_version_id"),
		revision: integer().notNull().default(0),
		createdAt: when("created_at").notNull(),
		resolvedAt: when("resolved_at"),
		resolvedBy: text("resolved_by").references(() => user.id),
		resolutionAction: feedbackResolutionAction("resolution_action"),
		resolutionOutcome:
			text("resolution_outcome").$type<FeedbackResolutionOutcome>(),
		resolutionReason: text("resolution_reason"),
		appliedL1VersionId: uuid("applied_l1_version_id"),
		reinstatedL2VersionId: uuid("reinstated_l2_version_id"),
		readAt: when("read_at"),
		readBy: text("read_by").references(() => user.id),
	},
	(t) => [
		foreignKey({
			name: "feedback_review_l1_round_scope_fk",
			columns: [t.driveId, t.candidateId, t.l1RoundId],
			foreignColumns: [
				interviewRound.driveId,
				interviewRound.candidateId,
				interviewRound.id,
			],
		}),
		foreignKey({
			name: "feedback_review_l2_round_scope_fk",
			columns: [t.driveId, t.candidateId, t.affectedL2RoundId],
			foreignColumns: [
				interviewRound.driveId,
				interviewRound.candidateId,
				interviewRound.id,
			],
		}),
		foreignKey({
			name: "feedback_review_previous_l1_fk",
			columns: [t.l1RoundId, t.previousL1VersionId],
			foreignColumns: [
				interviewAssessmentVersion.roundId,
				interviewAssessmentVersion.id,
			],
		}),
		foreignKey({
			name: "feedback_review_trigger_l1_fk",
			columns: [t.l1RoundId, t.triggerL1VersionId],
			foreignColumns: [
				interviewAssessmentVersion.roundId,
				interviewAssessmentVersion.id,
			],
		}),
		foreignKey({
			name: "feedback_review_affected_l2_fk",
			columns: [t.affectedL2RoundId, t.affectedL2VersionId],
			foreignColumns: [
				interviewAssessmentVersion.roundId,
				interviewAssessmentVersion.id,
			],
		}),
		foreignKey({
			name: "feedback_review_applied_l1_fk",
			columns: [t.l1RoundId, t.appliedL1VersionId],
			foreignColumns: [
				interviewAssessmentVersion.roundId,
				interviewAssessmentVersion.id,
			],
		}),
		foreignKey({
			name: "feedback_review_reinstated_l2_fk",
			columns: [t.affectedL2RoundId, t.reinstatedL2VersionId],
			foreignColumns: [
				interviewAssessmentVersion.roundId,
				interviewAssessmentVersion.id,
			],
		}),
		uniqueIndex("feedback_review_one_open")
			.on(t.driveId, t.candidateId)
			.where(sql`${t.kind} = 'pass_reversed' and ${t.resolvedAt} is null`),
		index("feedback_review_inbox")
			.on(t.createdAt, t.id)
			.where(
				sql`(${t.kind} = 'pass_reversed' and ${t.resolvedAt} is null) or (${t.kind} = 'handoff_updated' and ${t.readAt} is null)`,
			),
		check(
			"feedback_review_resolution_fields",
			sql`
		(${t.resolvedAt} is null and ${t.resolvedBy} is null and ${t.resolutionAction} is null and ${t.resolutionOutcome} is null and ${t.resolutionReason} is null and ${t.appliedL1VersionId} is null and ${t.reinstatedL2VersionId} is null)
		or (${t.kind} = 'pass_reversed' and ${t.resolvedAt} is not null and ${t.resolvedBy} is not null and ${t.resolutionAction} is not null and ${t.resolutionOutcome} is not null and ${t.resolutionReason} is not null and ${t.appliedL1VersionId} is not null and ((${t.resolutionAction} = 'reinstate_l2') = (${t.reinstatedL2VersionId} is not null)))`,
		),
		check(
			"feedback_review_acknowledgment_fields",
			sql`(${t.readAt} is null and ${t.readBy} is null) or (${t.kind} = 'handoff_updated' and ${t.readAt} is not null and ${t.readBy} is not null)`,
		),
	],
);

export const interviewInvitation = pgTable(
	"interview_invitation",
	{
		id: uuid().primaryKey(),
		roundId: uuid("round_id")
			.notNull()
			.references(() => interviewRound.id),
		secretHash: text("secret_hash").notNull(),
		generation: integer().notNull(),
		createdAt: when("created_at").notNull().defaultNow(),
		revokedAt: when("revoked_at"),
	},
	(t) => [
		unique("interview_invitation_generation").on(t.roundId, t.generation),
		unique("interview_invitation_scope").on(t.roundId, t.id),
		uniqueIndex("interview_invitation_current")
			.on(t.roundId)
			.where(sql`${t.revokedAt} is null`),
	],
);

export const interviewChallenge = pgTable(
	"interview_challenge",
	{
		id: uuid().primaryKey(),
		invitationId: uuid("invitation_id")
			.notNull()
			.references(() => interviewInvitation.id),
		codeDigest: text("code_digest").notNull(),
		phase: challengePhase().notNull(),
		createdAt: when("created_at").notNull(),
		expiresAt: when("expires_at").notNull(),
		attempts: integer().notNull().default(5),
		consumedAt: when("consumed_at"),
		revokedAt: when("revoked_at"),
	},
	(t) => [
		index("interview_challenge_budget").on(t.invitationId, t.createdAt),
		index("interview_challenge_expiry").on(t.expiresAt),
		uniqueIndex("interview_challenge_current")
			.on(t.invitationId)
			.where(sql`${t.revokedAt} is null and ${t.consumedAt} is null`),
		check("interview_challenge_attempts", sql`${t.attempts} between 0 and 5`),
	],
);

export const interviewSession = pgTable(
	"interview_session",
	{
		id: uuid().primaryKey().defaultRandom(),
		roundId: uuid("round_id").notNull(),
		invitationId: uuid("invitation_id").notNull(),
		tokenHash: text("token_hash").notNull().unique(),
		admittedAt: when("admitted_at").notNull(),
		lastSeenAt: when("last_seen_at"),
		confirmedAt: when("confirmed_at"),
		revokedAt: when("revoked_at"),
	},
	(t) => [
		foreignKey({
			name: "interview_session_invitation_fk",
			columns: [t.roundId, t.invitationId],
			foreignColumns: [interviewInvitation.roundId, interviewInvitation.id],
		}),
		uniqueIndex("interview_session_current")
			.on(t.roundId)
			.where(sql`${t.revokedAt} is null`),
	],
);

export const interviewAttendance = pgTable("interview_attendance", {
	roundId: uuid("round_id")
		.primaryKey()
		.references(() => interviewRound.id),
	name: text().notNull(),
	experienceTenths: integer("experience_tenths"),
	confirmedAt: when("confirmed_at").notNull(),
	lastSeenAt: when("last_seen_at"),
});

export const interviewEvent = pgTable(
	"interview_event",
	{
		id: uuid().primaryKey().defaultRandom(),
		driveId: uuid("drive_id").notNull(),
		candidateId: uuid("candidate_id").notNull(),
		roundId: uuid("round_id").references(() => interviewRound.id),
		actor: text().notNull(),
		actorId: text("actor_id").notNull(),
		action: text().notNull(),
		revision: integer().notNull(),
		createdAt: when("created_at").notNull().defaultNow(),
		assessmentVersionId: uuid("assessment_version_id").references(
			() => interviewAssessmentVersion.id,
		),
		feedbackReviewId: uuid("feedback_review_id").references(
			() => interviewFeedbackReview.id,
		),
	},
	(t) => [
		foreignKey({
			name: "interview_event_candidacy_fk",
			columns: [t.driveId, t.candidateId],
			foreignColumns: [driveCandidate.driveId, driveCandidate.id],
		}),
		index("interview_event_round").on(t.roundId, t.createdAt),
	],
);

export const interviewReceipt = pgTable(
	"interview_receipt",
	{
		actor: text().notNull(),
		actorId: text("actor_id").notNull(),
		commandId: uuid("command_id").notNull(),
		fingerprint: text().notNull(),
		resourceId: uuid("resource_id").notNull(),
		createdAt: when("created_at").notNull().defaultNow(),
	},
	(t) => [primaryKey({ columns: [t.actor, t.actorId, t.commandId] })],
);

export const interviewRateLimit = pgTable("interview_rate_limit", {
	key: text().primaryKey(),
	windowStart: when("window_start").notNull(),
	attempts: integer().notNull(),
});

export const interviewArtifactKind = pgEnum(
	"interview_artifact_kind",
	artifactKindSchema.enum,
);

export const interviewArtifactRevision = pgTable(
	"interview_artifact_revision",
	{
		id: uuid().primaryKey().defaultRandom(),
		roundId: uuid("round_id")
			.notNull()
			.references(() => interviewRound.id),
		kind: interviewArtifactKind().notNull(),
		sequence: integer().notNull(),
		schemaVersion: integer("schema_version").notNull(),
		payload: jsonb().$type<ArtifactPayload[keyof ArtifactPayload]>().notNull(),
		authorSessionId: uuid("author_session_id")
			.notNull()
			.references(() => interviewSession.id),
		savedAt: when("saved_at").notNull().defaultNow(),
	},
	(t) => [
		unique("interview_artifact_sequence_unique").on(
			t.roundId,
			t.kind,
			t.sequence,
		),
		unique("interview_artifact_revision_scope_unique").on(
			t.roundId,
			t.kind,
			t.id,
		),
		check("interview_artifact_sequence_positive", sql`${t.sequence} > 0`),
		check("interview_artifact_schema_positive", sql`${t.schemaVersion} > 0`),
	],
);

export const interviewArtifactHead = pgTable(
	"interview_artifact_head",
	{
		roundId: uuid("round_id").notNull(),
		kind: interviewArtifactKind().notNull(),
		revisionId: uuid("revision_id").notNull(),
	},
	(t) => [
		primaryKey({ columns: [t.roundId, t.kind] }),
		foreignKey({
			name: "interview_artifact_head_revision_fk",
			columns: [t.roundId, t.kind, t.revisionId],
			foreignColumns: [
				interviewArtifactRevision.roundId,
				interviewArtifactRevision.kind,
				interviewArtifactRevision.id,
			],
		}),
	],
);

export const interviewConcern = pgTable(
	"interview_concern",
	{
		id: uuid().primaryKey().defaultRandom(),
		roundId: uuid("round_id")
			.notNull()
			.references(() => interviewRound.id),
		authorId: text("author_id")
			.notNull()
			.references(() => user.id),
		commandId: uuid("command_id").notNull(),
		observation: text().notNull(),
		context: text().notNull(),
		createdAt: when("created_at").notNull().defaultNow(),
	},
	(t) => [
		unique("interview_concern_command_unique").on(
			t.roundId,
			t.authorId,
			t.commandId,
		),
	],
);
