import { z } from "zod";
import {
	assessmentDecisionSchema,
	assessmentViewSchema,
} from "./assessments.ts";
import {
	candidateEmailSchema,
	candidateFieldsSchema,
	roundSchema,
	skillSetSchema,
} from "./drives.ts";
import { feedbackReviewDetailSchema } from "./feedback-reviews.ts";
import type { StaffRole } from "./staff.ts";

export const canManageInterviews = (role: StaffRole) => role === "hr";
export const canViewAssignedInterviews = (role: StaffRole) =>
	role === "panelist";

const revision = z.number().int().min(0).max(2_147_483_647);
const name = candidateFieldsSchema.shape.name.pipe(z.string().min(1));
const years = candidateFieldsSchema.shape.years;
const duration = z.number().int().min(5).max(480);
const timeZone = z.string().trim().min(1).max(100);
const instant = z.iso.datetime();
const command = { commandId: z.uuid() };
const reason = z.string().trim().min(1).max(300);

export const interviewPreferencesSchema = z.object({
	timeZone,
	duration,
	revision,
});
export const defaultInterviewPreferences = {
	timeZone: "Asia/Kolkata",
	duration: 60,
	revision: 0,
};
export type InterviewPreferences = z.infer<typeof interviewPreferencesSchema>;

const httpsUrl = z
	.url({ protocol: /^https$/ })
	.max(2_048)
	.refine((value) => {
		const url = new URL(value);
		return !url.username && !url.password;
	});

export const meetingSchema = z.discriminatedUnion("mode", [
	z.object({ mode: z.literal("virtual"), teamsUrl: httpsUrl.nullable() }),
	z.object({
		mode: z.literal("in_person"),
		room: z.string().trim().min(1).max(160),
	}),
]);
export type InterviewMeeting = z.infer<typeof meetingSchema>;

export const interviewSlotSchema = z.object({
	date: z.iso.date(),
	time: z.string().regex(/^\d{2}:\d{2}$/),
	duration,
	offset: z
		.string()
		.regex(/^[+-]\d{2}:\d{2}(?::\d{2})?$/)
		.optional(),
});
export const interviewSlotPreviewSchema = z.object({
	start: instant,
	end: instant,
	offsets: z.array(z.string()),
});
export type InterviewSlot = z.infer<typeof interviewSlotSchema>;

const scheduleChange = {
	slot: interviewSlotSchema,
	acknowledge: z.hex().length(64).optional(),
};
export const bookInterviewSchema = z.object({
	...command,
	...scheduleChange,
	driveId: z.uuid(),
	candidateId: z.uuid(),
	candidateRevision: revision,
	workflowRevision: revision,
	skillRevision: revision,
	panelistId: z.string().min(1).max(128),
	level: roundSchema,
	preferenceRevision: revision,
	meeting: meetingSchema,
});
export type BookInterview = z.infer<typeof bookInterviewSchema>;

export const interviewStateSchema = z.enum([
	"scheduled",
	"active",
	"awaiting_feedback",
	"feedback_submitted",
	"cancelled",
	"no_show",
	"withdrawn",
]);
export const noShowPartySchema = z.enum(["candidate", "panelist", "both"]);
const change = { ...command, revision };
export const interviewCommandSchema = z.discriminatedUnion("action", [
	z.object({ ...change, action: z.literal("meeting"), meeting: meetingSchema }),
	z.object({ ...change, ...scheduleChange, action: z.literal("reschedule") }),
	z.object({
		...change,
		action: z.literal("reassign"),
		panelistId: z.string().min(1).max(128),
		acknowledge: scheduleChange.acknowledge,
	}),
	z.object({ ...change, action: z.literal("replace_link") }),
	z.object({ ...change, action: z.literal("cancel") }),
	z.object({
		...change,
		action: z.literal("cancel_unavailable_panelist"),
		reason,
	}),
	z.object({
		...change,
		action: z.literal("no_show"),
		absent: noShowPartySchema,
		reason,
	}),
	z.object({ ...change, action: z.literal("withdraw"), reason }),
	z.object({ ...change, action: z.literal("start") }),
	z.object({ ...change, action: z.literal("end") }),
]);
export type InterviewCommand = z.infer<typeof interviewCommandSchema>;
export const withdrawCandidacySchema = z.object({
	...change,
	workflowRevision: revision,
	reason,
});

const experienceParam = z.coerce.number().min(0).max(80).multipleOf(0.1);
export const interviewPageNumberSchema = z.coerce
	.number()
	.int()
	.min(1)
	.max(10_000);
const interviewFilters = {
	search: z.string().trim().max(120).default(""),
	driveId: z.uuid().optional(),
	level: roundSchema.optional(),
	minYears: experienceParam.optional(),
	maxYears: experienceParam.optional(),
	page: interviewPageNumberSchema.default(1),
};
function validExperience(value: { minYears?: number; maxYears?: number }) {
	return (
		value.minYears === undefined ||
		value.maxYears === undefined ||
		value.minYears <= value.maxYears
	);
}
export const interviewListQuerySchema = z
	.object({
		...interviewFilters,
		tab: z.enum(["queue", "scheduled", "history"]).default("queue"),
	})
	.refine(validExperience);
export type InterviewListQuery = z.infer<typeof interviewListQuerySchema>;
export const interviewWorkspaceQuerySchema = z
	.object({
		...interviewFilters,
		tab: z.enum(["queue", "scheduled", "awaiting", "history"]).default("queue"),
	})
	.refine(validExperience);
export type InterviewWorkspaceQuery = z.infer<
	typeof interviewWorkspaceQuerySchema
>;

const driveSummary = z.object({ id: z.uuid(), title: z.string() });
export const interviewPanelistSchema = z.object({
	id: z.string(),
	name: z.string(),
	email: z.email(),
});
export const interviewPanelistsSchema = z.array(interviewPanelistSchema);
export type InterviewPanelist = z.infer<typeof interviewPanelistSchema>;
const interviewCandidate = z.object({
	id: z.uuid(),
	drive: driveSummary,
	name,
	email: candidateEmailSchema,
	years,
	revision,
});
export const eligibleInterviewCandidateSchema = interviewCandidate.extend({
	level: roundSchema,
	lastAttempt: z.number().int().min(0),
	workflowRevision: revision,
	criteria: skillSetSchema,
	qualifyingL1RoundId: z.uuid().nullable(),
});
export type EligibleInterviewCandidate = z.infer<
	typeof eligibleInterviewCandidateSchema
>;

export const interviewCandidacySnapshotSchema = candidateFieldsSchema.extend({
	id: z.uuid(),
	revision,
});
export type InterviewCandidacySnapshot = z.infer<
	typeof interviewCandidacySnapshotSchema
>;

export const interviewScheduleSchema = z.object({
	start: instant,
	end: instant,
	timeZone,
	duration,
	meeting: meetingSchema,
});
export type InterviewSchedule = z.infer<typeof interviewScheduleSchema>;

const interviewCore = interviewScheduleSchema.extend({
	id: z.uuid(),
	level: roundSchema,
	attempt: z.number().int().positive(),
	state: interviewStateSchema,
	revision,
	candidate: z.object({ name, years }),
	startedAt: instant.nullable(),
	closedAt: instant.nullable(),
});
const attendance = z.object({
	confirmedAt: instant.nullable(),
	lastSeenAt: instant.nullable(),
	connected: z.boolean(),
});
export const assignedInterviewSchema = interviewCore.extend({
	drive: driveSummary,
	attendance,
});
export const assignedInterviewsSchema = z.object({
	page: interviewPageNumberSchema,
	hasNext: z.boolean(),
	items: z.array(assignedInterviewSchema),
});
export type AssignedInterview = z.infer<typeof assignedInterviewSchema>;

export const panelistRoundGroupSchema = z.enum([
	"attention",
	"upcoming",
	"submitted",
]);
export type PanelistRoundGroup = z.infer<typeof panelistRoundGroupSchema>;

const panelistDashboardRoundSchema = assignedInterviewSchema
	.pick({
		id: true,
		level: true,
		attempt: true,
		state: true,
		start: true,
		end: true,
		timeZone: true,
		candidate: true,
		drive: true,
		closedAt: true,
	})
	.extend({ connected: z.boolean(), submittedAt: instant.nullable() });
export type PanelistDashboardRound = z.infer<
	typeof panelistDashboardRoundSchema
>;

const panelistDashboardGroupSchema = z.object({
	total: z.number().int().nonnegative(),
	items: z.array(panelistDashboardRoundSchema),
});
export const panelistDashboardSchema = z.record(
	panelistRoundGroupSchema,
	panelistDashboardGroupSchema,
);

export const hrInterviewSchema = assignedInterviewSchema.extend({
	qualifyingL1RoundId: z.uuid().nullable().optional(),
	panelist: interviewPanelistSchema,
	canMarkNoShow: z.boolean(),
	canCancelUnavailablePanelist: z.boolean(),
	decision: assessmentDecisionSchema.nullable(),
	effectiveOutcome: z
		.enum(["withdrawn", "do_not_proceed", "selected", "not_selected"])
		.nullable(),
	pendingReviewId: z.uuid().nullable(),
	reviewAffectsRound: z.boolean(),
	superseded: z.boolean(),
	candidate: interviewCandidate.omit({
		drive: true,
		revision: true,
	}),
	reason: z.string().nullable(),
	absent: noShowPartySchema.nullable(),
	confirmedProfile: z.object({ name, years }).nullable(),
});
export type HrInterview = z.infer<typeof hrInterviewSchema>;

const pagination = {
	page: z.number(),
	total: z.number(),
	pageSize: z.number(),
	drives: z.array(driveSummary),
};
export const interviewListSchema = z.discriminatedUnion("tab", [
	z.object({
		...pagination,
		tab: z.literal("queue"),
		items: z.array(eligibleInterviewCandidateSchema),
	}),
	z.object({
		...pagination,
		tab: z.enum(["scheduled", "history"]),
		items: z.array(hrInterviewSchema),
	}),
]);
export const interviewWorkspaceSchema = z.object({
	...pagination,
	tab: interviewWorkspaceQuerySchema.shape.tab,
	total: z.number(),
	actionTotal: z.number(),
	items: z.array(
		z.object({
			id: z.uuid(),
			drive: driveSummary,
			name,
			email: z.string().nullable(),
			years,
			level: roundSchema.nullable(),
			// This identifier follows the candidacy's effective L1 scorecard.
			l1RoundId: z.uuid().nullable(),
			hasAttempts: z.boolean(),
			action: z
				.enum([
					"schedule",
					"review_skills",
					"review_feedback",
					"replace_panelist",
					"review_attendance",
				])
				.nullable(),
			reviewId: z.uuid().nullable(),
			outcome: hrInterviewSchema.shape.effectiveOutcome,
			round: hrInterviewSchema.nullable(),
			eligible: eligibleInterviewCandidateSchema.nullable(),
		}),
	),
});
export type InterviewWorkspaceItem = z.infer<
	typeof interviewWorkspaceSchema
>["items"][number];
export const hrInterviewDashboardSchema = z.record(
	interviewWorkspaceQuerySchema.shape.tab,
	interviewWorkspaceSchema.pick({ total: true, items: true }),
);
export const interviewTimelineSchema = z.object({
	page: z.number(),
	hasNext: z.boolean(),
	withdrawal: z.object({ reason: z.string(), at: instant }).nullable(),
	items: z.array(hrInterviewSchema),
});
export const interviewResultSchema = z.object({ id: z.uuid() });
export const interviewInvitationSchema = z.object({
	link: z.url(),
	text: z.string(),
});
const secret = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
export const requestInterviewCodeSchema = z.object({
	email: candidateEmailSchema,
	secret,
});
export const verifyInterviewCodeSchema = requestInterviewCodeSchema.extend({
	challengeId: z.uuid(),
	code: z.string().regex(/^\d{6}$/),
});
export const interviewChallengeSchema = z.object({
	challengeId: z.uuid(),
	expiresAt: instant,
	resendAt: instant,
});
export const confirmInterviewProfileSchema = z.object({ name, years });
export const candidateInterviewSchema = interviewCore
	.omit({ attempt: true })
	.extend({
		confirmed: z.boolean(),
	});
export type CandidateInterview = z.infer<typeof candidateInterviewSchema>;
export const candidateEndSchema = z.object(change);
export const interviewCompleteSchema = z.object({ completed: z.literal(true) });

export const interviewConflictSchema = z.object({
	id: z.uuid(),
	drive: driveSummary,
	resources: z.array(z.enum(["candidate", "panelist"])),
	start: instant,
	end: instant.nullable(),
	timeZone,
});
export type InterviewConflict = z.infer<typeof interviewConflictSchema>;
export const interviewErrorSchema = z.object({
	error: z.enum([
		"invalid_input",
		"invalid_time_zone",
		"invalid_slot",
		"nonexistent_time",
		"ambiguous_time",
		"round_not_eligible",
		"panelist_ineligible",
		"slot_conflict",
		"preferences_changed",
		"skills_need_review",
		"skills_changed",
		"workflow_changed",
		"draft_changed",
		"assessment_incomplete",
		"l1_handoff_changed",
		"pending_feedback_review",
		"feedback_version_changed",
		"feedback_review_changed",
		"revision_conflict",
		"idempotency_conflict",
		"invalid_transition",
		"candidate_not_present",
		"too_early",
		"entry_closed",
		"invite_unavailable",
		"invalid_code",
		"delivery_failed",
		"rate_limited",
		"unavailable",
		"not_found",
		"unauthenticated",
		"forbidden",
		"untrusted_origin",
	]),
	field: z.string().optional(),
	preferences: interviewPreferencesSchema.optional(),
	criteria: skillSetSchema.optional(),
	assessment: assessmentViewSchema.optional(),
	review: feedbackReviewDetailSchema.optional(),
	workflowRevision: revision.optional(),
	candidacy: interviewCandidacySnapshotSchema.optional(),
	round: z
		.union([
			hrInterviewSchema,
			assignedInterviewSchema,
			candidateInterviewSchema,
		])
		.optional(),
	conflicts: z.array(interviewConflictSchema).optional(),
	acknowledge: z.string().optional(),
	offsets: z.array(z.string()).optional(),
	opensAt: instant.optional(),
	retryAfter: z.number().int().positive().optional(),
});
export type InterviewError = z.infer<typeof interviewErrorSchema>;
