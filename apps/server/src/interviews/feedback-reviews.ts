import type {
	FeedbackReviewDetail,
	resolveFeedbackReviewSchema,
} from "@studio/contracts";
import { and, count, desc, eq, isNull, or } from "drizzle-orm";
import type { z } from "zod";
import { drive, driveCandidate } from "../drives/schema.ts";
import { user } from "../staff/auth-schema.ts";
import { getStaff } from "../staff/roles.ts";
import { readSubmittedVersion, versionMetadata } from "./assessments.ts";
import { InterviewProblem } from "./problem.ts";
import { interviewFeedbackReview, interviewRound } from "./schema.ts";
import {
	commandReceipt,
	currentTime,
	type Database,
	type InterviewConfig,
	lockCandidacy,
	lockStaff,
	recordEvent,
	type Transaction,
} from "./store.ts";
import {
	advanceWorkflow,
	openFeedbackReview,
	readCandidacyWorkflow,
} from "./workflow.ts";

const reviewTable = interviewFeedbackReview;
const unreadHandoff = and(
	eq(reviewTable.kind, "handoff_updated"),
	isNull(reviewTable.readAt),
);
const inboxFilter = or(openFeedbackReview, unreadHandoff);

function reviewRows(tx: Transaction) {
	return tx
		.select({
			review: reviewTable,
			candidate: { id: driveCandidate.id, name: driveCandidate.name },
			drive: { id: drive.id, title: drive.name },
		})
		.from(reviewTable)
		.innerJoin(
			driveCandidate,
			and(
				eq(driveCandidate.driveId, reviewTable.driveId),
				eq(driveCandidate.id, reviewTable.candidateId),
			),
		)
		.innerJoin(drive, eq(drive.id, reviewTable.driveId));
}

type ReviewRow = Awaited<ReturnType<typeof reviewRows>>[number];

function summary({ review, candidate, drive }: ReviewRow) {
	return {
		id: review.id,
		kind: review.kind,
		createdAt: review.createdAt.toISOString(),
		candidate,
		drive,
	};
}

export function listFeedbackReviews(
	database: Database,
	config: InterviewConfig,
	staffId: string,
	page: number,
	updatesOnly = false,
) {
	return database.transaction(
		async (tx) => {
			if ((await getStaff(tx, staffId, config.domains))?.role !== "hr")
				throw new InterviewProblem(403, "forbidden");
			const pageSize = 20;
			const filter = updatesOnly ? unreadHandoff : inboxFilter;
			const [result] = await tx
				.select({ total: count() })
				.from(reviewTable)
				.where(filter);
			const rows = await reviewRows(tx)
				.where(filter)
				.orderBy(desc(reviewTable.createdAt), desc(reviewTable.id))
				.limit(pageSize)
				.offset((page - 1) * pageSize);
			return { page, pageSize, total: result.total, items: rows.map(summary) };
		},
		{ isolationLevel: "repeatable read", accessMode: "read only" },
	);
}

async function readReview(
	tx: Transaction,
	id: string,
): Promise<FeedbackReviewDetail> {
	const [row] = await reviewRows(tx).where(eq(reviewTable.id, id));
	if (!row) throw new InterviewProblem(404, "not_found");
	const { review } = row;
	const open = review.kind === "pass_reversed" && review.resolvedAt === null;
	const latestId = open
		? (await readCandidacyWorkflow(tx, review)).progress?.l1VersionId
		: (review.appliedL1VersionId ?? review.triggerL1VersionId);
	if (!latestId) throw new InterviewProblem(409, "invalid_transition");
	const previous = await readSubmittedVersion(
		tx,
		review.l1RoundId,
		review.previousL1VersionId,
	);
	const trigger = await readSubmittedVersion(
		tx,
		review.l1RoundId,
		review.triggerL1VersionId,
	);
	const latest =
		latestId === trigger?.id
			? trigger
			: await readSubmittedVersion(tx, review.l1RoundId, latestId);
	const l2Version = review.affectedL2VersionId
		? await readSubmittedVersion(
				tx,
				review.affectedL2RoundId,
				review.affectedL2VersionId,
			)
		: null;
	if (!previous || !trigger || !latest)
		throw new InterviewProblem(409, "invalid_transition");
	const [l2] = await tx
		.select({ id: interviewRound.id, attempt: interviewRound.attempt })
		.from(interviewRound)
		.where(eq(interviewRound.id, review.affectedL2RoundId));
	const actorId = review.resolvedBy ?? review.readBy;
	const [actor] = actorId
		? await tx
				.select({ id: user.id, name: user.name })
				.from(user)
				.where(eq(user.id, actorId))
		: [];
	let availableResolution: FeedbackReviewDetail["availableResolution"] = null;
	if (open) {
		if (
			latest.decision === "do_not_proceed" ||
			latest.decision === "incomplete"
		) {
			availableResolution = {
				action: "apply_l1",
				outcome:
					latest.decision === "incomplete" ? "schedule_l1" : "do_not_proceed",
			};
		} else if (latest.decision === "pass") {
			availableResolution = l2Version
				? {
						action: "reinstate_l2",
						outcome:
							l2Version.decision === "selected" ||
							l2Version.decision === "not_selected"
								? l2Version.decision
								: "schedule_l2",
					}
				: { action: "rebook_l2", outcome: "schedule_l2" };
		}
	}
	return {
		...summary(row),
		revision: review.revision,
		l1RoundId: review.l1RoundId,
		l2,
		previousL1: versionMetadata(previous),
		triggerL1: versionMetadata(trigger),
		latestL1: versionMetadata(latest),
		l2Version: l2Version ? versionMetadata(l2Version) : null,
		availableResolution,
		resolution:
			review.resolvedAt &&
			review.resolutionAction &&
			review.resolutionOutcome &&
			review.resolutionReason &&
			review.appliedL1VersionId &&
			actor
				? {
						resolvedAt: review.resolvedAt.toISOString(),
						resolvedBy: actor,
						action: review.resolutionAction,
						outcome: review.resolutionOutcome,
						reason: review.resolutionReason,
						appliedL1VersionId: review.appliedL1VersionId,
						reinstatedL2VersionId: review.reinstatedL2VersionId,
					}
				: null,
		acknowledgment:
			review.readAt && actor
				? { readAt: review.readAt.toISOString(), readBy: actor }
				: null,
	};
}

export function getFeedbackReview(
	database: Database,
	config: InterviewConfig,
	staffId: string,
	id: string,
) {
	return database.transaction(
		async (tx) => {
			if ((await getStaff(tx, staffId, config.domains))?.role !== "hr")
				throw new InterviewProblem(403, "forbidden");
			return readReview(tx, id);
		},
		{ isolationLevel: "repeatable read", accessMode: "read only" },
	);
}

type ReviewCommand =
	| { action: "acknowledge"; commandId: string }
	| {
			action: "resolve";
			resolution: z.infer<typeof resolveFeedbackReviewSchema>;
			commandId: string;
	  };

export function changeFeedbackReview(
	database: Database,
	config: InterviewConfig,
	staffId: string,
	id: string,
	command: ReviewCommand,
) {
	return database.transaction(async (tx) => {
		const actor = { actor: "staff", actorId: staffId } as const;
		const receipt = await commandReceipt(
			tx,
			config,
			actor,
			command,
			`feedback-review:${id}`,
		);
		const [scope] = await tx
			.select({
				driveId: reviewTable.driveId,
				candidateId: reviewTable.candidateId,
			})
			.from(reviewTable)
			.where(eq(reviewTable.id, id));
		if (!scope) throw new InterviewProblem(404, "not_found");
		await lockCandidacy(tx, scope.driveId, scope.candidateId);
		if ((await lockStaff(tx, staffId, config.domains))?.role !== "hr")
			throw new InterviewProblem(403, "forbidden");
		if (receipt.previous) {
			if (!receipt.matches)
				throw new InterviewProblem(409, "idempotency_conflict");
			return { id };
		}
		const [review] = await tx
			.select()
			.from(reviewTable)
			.where(eq(reviewTable.id, id))
			.for("update");
		const now = currentTime(config);
		if (command.action === "acknowledge") {
			if (review.kind !== "handoff_updated")
				throw new InterviewProblem(409, "invalid_transition");
			if (!review.readAt) {
				await tx
					.update(reviewTable)
					.set({ readAt: now, readBy: staffId })
					.where(eq(reviewTable.id, id));
				await recordEvent(
					tx,
					actor,
					scope,
					"feedback_notification_read",
					review.revision,
					review.l1RoundId,
					{
						feedbackReviewId: id,
						assessmentVersionId: review.triggerL1VersionId,
					},
				);
			}
		} else {
			const input = command.resolution;
			const detail = await readReview(tx, id);
			if (
				detail.revision !== input.expectedRevision ||
				detail.latestL1.id !== input.expectedL1VersionId ||
				detail.availableResolution?.action !== input.action
			) {
				throw new InterviewProblem(409, "feedback_review_changed", {
					review: detail,
				});
			}
			const workflow = await readCandidacyWorkflow(tx, scope);
			if (
				workflow.withdrawn ||
				workflow.pending?.id !== id ||
				workflow.progress?.currentL2RoundId !== review.affectedL2RoundId
			)
				throw new InterviewProblem(409, "invalid_transition");
			const reinstatedL2 =
				input.action === "reinstate_l2" ? review.affectedL2VersionId : null;
			if (input.action === "reinstate_l2") {
				const current = await readSubmittedVersion(
					tx,
					review.affectedL2RoundId,
				);
				if (!current || current.id !== reinstatedL2)
					throw new InterviewProblem(409, "invalid_transition");
			}
			const revision = review.revision + 1;
			const applied = detail.latestL1.id;
			await tx
				.update(reviewTable)
				.set({
					revision,
					resolvedAt: now,
					resolvedBy: staffId,
					resolutionReason: input.reason,
					resolutionAction: input.action,
					resolutionOutcome: detail.availableResolution.outcome,
					appliedL1VersionId: applied,
					reinstatedL2VersionId: reinstatedL2,
				})
				.where(eq(reviewTable.id, id));
			await advanceWorkflow(tx, scope, {
				currentL2RoundId: reinstatedL2 ? review.affectedL2RoundId : null,
			});
			await recordEvent(
				tx,
				actor,
				scope,
				`feedback_review_${input.action}`,
				revision,
				review.l1RoundId,
				{ feedbackReviewId: id, assessmentVersionId: applied },
			);
		}
		await receipt.record(id);
		return { id };
	});
}
