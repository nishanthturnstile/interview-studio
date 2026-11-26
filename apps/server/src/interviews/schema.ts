import {
	type InterviewMeeting,
	interviewStateSchema,
	noShowPartySchema,
} from "@studio/contracts";
import { sql } from "drizzle-orm";
import {
	check,
	foreignKey,
	index,
	integer,
	jsonb,
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
		reason: text(),
		absent: noShowParty(),
	},
	(t) => [
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
		uniqueIndex("interview_round_unresolved")
			.on(t.driveId, t.candidateId, t.level)
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
