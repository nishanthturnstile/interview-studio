import {
	type AssessmentCriteria,
	type AssessmentDraft,
	type AssessmentVersionMetadata,
	type AssessmentView,
	assessmentDecisionsByRound,
	assessmentScorecardSchema,
	type assessmentVersionDetailSchema,
	type correctAssessmentSchema,
	type saveAssessmentDraftSchema,
	type submitAssessmentSchema,
} from "@studio/contracts";
import { and, asc, desc, eq, gt, inArray, isNull } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { z } from "zod";
import { driveSkills } from "../drives/schema.ts";
import { user } from "../staff/auth-schema.ts";
import { getStaff } from "../staff/roles.ts";
import { InterviewProblem } from "./problem.ts";
import {
	interviewAssessment,
	interviewAssessmentVersion,
	interviewFeedbackReview,
	interviewProgress,
	interviewRound,
} from "./schema.ts";
import {
	type Actor,
	commandReceipt,
	currentTime,
	type Database,
	hash,
	type InterviewConfig,
	lockCandidacy,
	lockResources,
	lockStaff,
	type RoundRow,
	recordEvent,
	revokeAdmission,
	type Transaction,
} from "./store.ts";
import {
	advanceWorkflow,
	captureCriteria,
	criteriaView,
	lockCriteria,
	readCandidacyWorkflow,
	requireNoPendingReview,
	unresolved,
} from "./workflow.ts";

function isEditable(round: RoundRow) {
	return round.state === "active" || round.state === "awaiting_feedback";
}

function assignedWhere(roundId: string, panelistId: string) {
	return and(
		eq(interviewRound.id, roundId),
		eq(interviewRound.panelistId, panelistId),
	);
}

export async function readSubmittedVersion(
	tx: Transaction,
	roundId: string,
	versionId?: string,
) {
	const [row] = await tx
		.select({
			version: interviewAssessmentVersion,
			author: { id: user.id, name: user.name },
		})
		.from(interviewAssessmentVersion)
		.innerJoin(user, eq(user.id, interviewAssessmentVersion.authorId))
		.where(
			and(
				eq(interviewAssessmentVersion.roundId, roundId),
				versionId ? eq(interviewAssessmentVersion.id, versionId) : undefined,
			),
		)
		.orderBy(desc(interviewAssessmentVersion.version))
		.limit(1);
	if (!row) return null;
	const {
		id,
		version,
		previousVersionId,
		correctionReason,
		reviewedL1VersionId,
		decision,
		ratings,
		rationale,
		submittedAt,
	} = row.version;
	return {
		id,
		version,
		previousVersionId,
		correctionReason,
		reviewedL1VersionId,
		decision,
		ratings,
		rationale,
		submittedAt: submittedAt.toISOString(),
		author: row.author,
	};
}

type SubmittedVersion = NonNullable<
	Awaited<ReturnType<typeof readSubmittedVersion>>
>;
type CandidacyWorkflow = Awaited<ReturnType<typeof readCandidacyWorkflow>>;

export function versionMetadata({
	ratings: _ratings,
	rationale: _rationale,
	...metadata
}: SubmittedVersion): AssessmentVersionMetadata {
	return metadata;
}

async function canCorrectSubmission(
	tx: Transaction,
	round: RoundRow,
	submitted: SubmittedVersion,
	workflow: CandidacyWorkflow,
) {
	if (workflow.withdrawn || round.state !== "feedback_submitted") return false;
	if (
		round.level === "l1"
			? workflow.progress?.l1VersionId !== submitted.id
			: workflow.pending || workflow.progress?.currentL2RoundId !== round.id
	)
		return false;
	const [newer] = await tx
		.select({ id: interviewRound.id })
		.from(interviewRound)
		.where(
			and(
				eq(interviewRound.driveId, round.driveId),
				eq(interviewRound.candidateId, round.candidateId),
				eq(interviewRound.level, round.level),
				gt(interviewRound.attempt, round.attempt),
			),
		)
		.limit(1);
	return !newer;
}

async function currentPassingL1(tx: Transaction, l2: RoundRow) {
	if (
		l2.level !== "l2" ||
		!l2.qualifyingL1RoundId ||
		!unresolved.some((state) => state === l2.state)
	)
		return null;
	const [pass] = await tx
		.select({ id: interviewAssessmentVersion.id })
		.from(interviewProgress)
		.innerJoin(
			interviewAssessmentVersion,
			eq(interviewAssessmentVersion.id, interviewProgress.l1VersionId),
		)
		.where(
			and(
				eq(interviewProgress.driveId, l2.driveId),
				eq(interviewProgress.candidateId, l2.candidateId),
				eq(interviewProgress.currentL2RoundId, l2.id),
				eq(interviewAssessmentVersion.roundId, l2.qualifyingL1RoundId),
				eq(interviewAssessmentVersion.decision, "pass"),
			),
		);
	return pass?.id ?? null;
}

async function readL1Handoff(
	tx: Transaction,
	round: RoundRow,
	submitted: Awaited<ReturnType<typeof readSubmittedVersion>>,
): Promise<AssessmentView["l1Handoff"]> {
	if (round.level !== "l2" || !round.qualifyingL1RoundId) return null;
	const versionId = submitted
		? submitted.reviewedL1VersionId
		: await currentPassingL1(tx, round);
	if (!versionId) return null;
	const scorecard = await readSubmittedVersion(
		tx,
		round.qualifyingL1RoundId,
		versionId,
	);
	if (scorecard?.decision !== "pass") return null;
	const [snapshot] = await tx
		.select({ criteria: interviewAssessment.criteria })
		.from(interviewAssessment)
		.where(eq(interviewAssessment.roundId, round.qualifyingL1RoundId));
	return { criteria: snapshot.criteria, submitted: scorecard };
}

async function roundAssessment(tx: Transaction, roundId: string) {
	const [assessment] = await tx
		.select()
		.from(interviewAssessment)
		.where(eq(interviewAssessment.roundId, roundId));
	return assessment;
}

async function assignedAssessmentView(
	tx: Transaction,
	round: RoundRow,
	assessment: Awaited<ReturnType<typeof roundAssessment>> | undefined,
): Promise<AssessmentView> {
	let status: AssessmentView["status"] = assessment
		? "available"
		: "unavailable";
	if (!assessment && round.legacyAssessment && isEditable(round)) {
		const [skills] = await tx
			.select()
			.from(driveSkills)
			.where(
				and(
					eq(driveSkills.driveId, round.driveId),
					eq(driveSkills.round, round.level),
				),
			);
		const criteria = criteriaView(round.level, skills ?? null);
		status =
			criteria.reviewedAt && criteria.skills.length
				? "initialize"
				: "skills_need_review";
	}
	const submitted = assessment
		? await readSubmittedVersion(tx, round.id)
		: null;
	const l1Handoff = await readL1Handoff(tx, round, submitted);
	const canEdit =
		Boolean(assessment) &&
		isEditable(round) &&
		(round.level === "l1" || l1Handoff !== null);
	return {
		status,
		attemptRevision: round.revision,
		criteria: assessment?.criteria ?? null,
		draft: assessment
			? {
					content: assessment.draft,
					revision: assessment.draftRevision,
					updatedAt: assessment.draftUpdatedAt?.toISOString() ?? null,
				}
			: null,
		submitted,
		l1Handoff,
		canEdit,
		canSubmit: canEdit && round.state === "awaiting_feedback",
		canCorrect: submitted
			? await canCorrectSubmission(
					tx,
					round,
					submitted,
					await readCandidacyWorkflow(tx, round),
				)
			: false,
	};
}

// A tag covers the revisions and display metadata of one repeatable-read snapshot.
function assessmentTag(...parts: (string | number | null)[]) {
	return `"${hash(JSON.stringify(parts))}"`;
}

export function getAssignedAssessment(
	database: Database,
	config: InterviewConfig,
	staffId: string,
	id: string,
): Promise<AssessmentView>;
export function getAssignedAssessment(
	database: Database,
	config: InterviewConfig,
	staffId: string,
	id: string,
	known: string | undefined,
): Promise<AssessmentView | null>;
export function getAssignedAssessment(
	database: Database,
	config: InterviewConfig,
	staffId: string,
	id: string,
	known?: string,
) {
	return database.transaction(
		async (tx): Promise<AssessmentView | null> => {
			const staff = await getStaff(tx, staffId, config.domains);
			if (staff?.role !== "panelist")
				throw new InterviewProblem(403, "forbidden");
			const qualifyingRound = alias(
				interviewRound,
				"assessment_qualifying_round",
			);
			const handoffAuthor = alias(user, "assessment_handoff_author");
			const [snapshot] = await tx
				.select({
					round: interviewRound,
					draftRevision: interviewAssessment.draftRevision,
					workflowRevision: interviewProgress.revision,
					skillRevision: driveSkills.revision,
					handoffAuthorName: handoffAuthor.name,
				})
				.from(interviewRound)
				.leftJoin(
					interviewAssessment,
					eq(interviewAssessment.roundId, interviewRound.id),
				)
				.leftJoin(
					interviewProgress,
					and(
						eq(interviewProgress.driveId, interviewRound.driveId),
						eq(interviewProgress.candidateId, interviewRound.candidateId),
					),
				)
				.leftJoin(
					driveSkills,
					and(
						eq(driveSkills.driveId, interviewRound.driveId),
						eq(driveSkills.round, interviewRound.level),
						eq(interviewRound.legacyAssessment, true),
						isNull(interviewAssessment.roundId),
					),
				)
				.leftJoin(
					qualifyingRound,
					eq(qualifyingRound.id, interviewRound.qualifyingL1RoundId),
				)
				.leftJoin(
					handoffAuthor,
					eq(handoffAuthor.id, qualifyingRound.panelistId),
				)
				.where(assignedWhere(id, staffId));
			if (!snapshot) throw new InterviewProblem(404, "not_found");
			const {
				round,
				draftRevision,
				workflowRevision,
				skillRevision,
				handoffAuthorName,
			} = snapshot;
			const revisionTag = assessmentTag(
				id,
				round.revision,
				draftRevision,
				workflowRevision,
				skillRevision,
				staff.name,
				handoffAuthorName,
			);
			if (known === revisionTag) return null;
			return {
				...(await assignedAssessmentView(
					tx,
					round,
					await roundAssessment(tx, id),
				)),
				revisionTag,
			};
		},
		{ isolationLevel: "repeatable read", accessMode: "read only" },
	);
}

type HrAssessment = NonNullable<Awaited<ReturnType<typeof readHrAssessment>>>;

export function getHrAssessment(
	database: Database,
	config: InterviewConfig,
	staffId: string,
	id: string,
): Promise<HrAssessment>;
export function getHrAssessment(
	database: Database,
	config: InterviewConfig,
	staffId: string,
	id: string,
	known: string | undefined,
): Promise<HrAssessment | null>;
export function getHrAssessment(
	database: Database,
	config: InterviewConfig,
	staffId: string,
	id: string,
	known?: string,
) {
	return database.transaction(
		(tx) => readHrAssessment(tx, config, staffId, id, known),
		{ isolationLevel: "repeatable read", accessMode: "read only" },
	);
}

async function readHrAssessment(
	tx: Transaction,
	config: InterviewConfig,
	staffId: string,
	id: string,
	known: string | undefined,
) {
	if ((await getStaff(tx, staffId, config.domains))?.role !== "hr")
		throw new InterviewProblem(403, "forbidden");
	const [head] = await tx
		.select({ id: interviewAssessmentVersion.id, authorName: user.name })
		.from(interviewAssessmentVersion)
		.innerJoin(user, eq(user.id, interviewAssessmentVersion.authorId))
		.where(eq(interviewAssessmentVersion.roundId, id))
		.orderBy(desc(interviewAssessmentVersion.version))
		.limit(1);
	if (!head) throw new InterviewProblem(404, "not_found");
	const revisionTag = assessmentTag(id, head.id, head.authorName);
	if (known === revisionTag) return null;
	const submitted = await readSubmittedVersion(tx, id, head.id);
	if (!submitted) throw new InterviewProblem(404, "not_found");
	const [assessment] = await tx
		.select({ criteria: interviewAssessment.criteria })
		.from(interviewAssessment)
		.where(eq(interviewAssessment.roundId, id));
	return { criteria: assessment.criteria, submitted, revisionTag };
}

type AssessmentCommand =
	| { action: "initialize"; commandId: string }
	| ({ action: "draft" } & z.infer<typeof saveAssessmentDraftSchema>)
	| ({ action: "submit" } & z.infer<typeof submitAssessmentSchema>);

function validateRatings(
	content: Pick<AssessmentDraft, "ratings">,
	criteria: AssessmentCriteria,
) {
	const skillIds = new Set(criteria.skills.map(({ id }) => id));
	if (content.ratings.some(({ skillId }) => !skillIds.has(skillId)))
		throw new InterviewProblem(400, "invalid_input", { field: "ratings" });
}

function validateDecision(
	round: RoundRow,
	decision: AssessmentDraft["decision"],
) {
	if (
		decision &&
		!assessmentDecisionsByRound[round.level].some(
			(allowed) => allowed === decision,
		)
	)
		throw new InterviewProblem(400, "invalid_input", { field: "decision" });
}

export function changeAssessment(
	database: Database,
	config: InterviewConfig,
	staffId: string,
	id: string,
	input: AssessmentCommand,
) {
	return database.transaction(async (tx) => {
		const actor = { actor: "staff", actorId: staffId } as const;
		const receipt = await commandReceipt(
			tx,
			config,
			actor,
			input,
			`assessment:${id}`,
		);
		const [scope] = await tx
			.select()
			.from(interviewRound)
			.where(assignedWhere(id, staffId));
		if (!scope) throw new InterviewProblem(404, "not_found");
		await lockCandidacy(tx, scope.driveId, scope.candidateId);
		const reviewed =
			input.action === "initialize" &&
			scope.legacyAssessment &&
			!receipt.previous
				? await lockCriteria(tx, scope.driveId, scope.level)
				: null;
		if ((await lockStaff(tx, staffId, config.domains))?.role !== "panelist")
			throw new InterviewProblem(403, "forbidden");
		const [round] = await tx
			.select()
			.from(interviewRound)
			.where(assignedWhere(id, staffId))
			.for("update");
		if (!round) throw new InterviewProblem(404, "not_found");
		if (receipt.previous) {
			if (!receipt.matches)
				throw new InterviewProblem(409, "idempotency_conflict");
			return { id: receipt.previous.resourceId };
		}

		const assessment = await roundAssessment(tx, id);
		const now = currentTime(config);
		let resourceId = id;
		if (input.action === "initialize") {
			if (!reviewed || !isEditable(round))
				throw new InterviewProblem(409, "invalid_transition");
			if (!assessment) {
				await tx.insert(interviewAssessment).values({
					roundId: id,
					criteria: captureCriteria(reviewed, "after_booking", now),
				});
				await recordEvent(
					tx,
					actor,
					round,
					"assessment_initialized",
					round.revision,
					id,
				);
			}
		} else {
			if (round.level === "l2") await requireNoPendingReview(tx, round);
			if (!assessment || !isEditable(round))
				throw new InterviewProblem(409, "invalid_transition");
			const passingL1 = await currentPassingL1(tx, round);
			if (round.level === "l2" && !passingL1)
				throw new InterviewProblem(409, "invalid_transition");
			if (assessment.draftRevision !== input.draftRevision)
				throw new InterviewProblem(409, "draft_changed", {
					assessment: await assignedAssessmentView(tx, round, assessment),
				});
			if (input.action === "draft") {
				validateRatings(input.content, assessment.criteria);
				validateDecision(round, input.content.decision);
				const revision = assessment.draftRevision + 1;
				await tx
					.update(interviewAssessment)
					.set({
						draft: input.content,
						draftRevision: revision,
						draftUpdatedAt: now,
					})
					.where(eq(interviewAssessment.roundId, id));
				await recordEvent(
					tx,
					actor,
					round,
					"assessment_draft_saved",
					revision,
					id,
				);
			} else {
				if (round.revision !== input.attemptRevision)
					throw new InterviewProblem(409, "revision_conflict", {
						assessment: await assignedAssessmentView(tx, round, assessment),
					});
				if (round.state !== "awaiting_feedback")
					throw new InterviewProblem(409, "invalid_transition");
				if (round.level === "l2" && input.reviewedL1VersionId !== passingL1)
					throw new InterviewProblem(409, "l1_handoff_changed", {
						assessment: await assignedAssessmentView(tx, round, assessment),
					});
				if (round.level === "l1" && input.reviewedL1VersionId)
					throw new InterviewProblem(400, "invalid_input", {
						field: "reviewedL1VersionId",
					});
				const scorecard = assessmentScorecardSchema.safeParse(assessment.draft);
				if (
					!scorecard.success ||
					scorecard.data.ratings.length !== assessment.criteria.skills.length
				)
					throw new InterviewProblem(409, "assessment_incomplete");
				validateRatings(assessment.draft, assessment.criteria);
				validateDecision(round, scorecard.data.decision);
				const [version] = await tx
					.insert(interviewAssessmentVersion)
					.values({
						...scorecard.data,
						roundId: id,
						version: 1,
						reviewedL1VersionId: passingL1,
						authorId: staffId,
						submittedAt: now,
					})
					.returning({ id: interviewAssessmentVersion.id });
				const revision = round.revision + 1;
				await tx
					.update(interviewRound)
					.set({ state: "feedback_submitted", revision })
					.where(eq(interviewRound.id, id));
				await advanceWorkflow(
					tx,
					round,
					round.level === "l1" ? { l1VersionId: version.id } : undefined,
				);
				await recordEvent(
					tx,
					actor,
					round,
					"assessment_submitted",
					revision,
					id,
					{ assessmentVersionId: version.id },
				);
				resourceId = version.id;
			}
		}
		await receipt.record(resourceId);
		return { id: resourceId };
	});
}

export function correctAssessment(
	database: Database,
	config: InterviewConfig,
	staffId: string,
	id: string,
	input: z.infer<typeof correctAssessmentSchema>,
) {
	return database.transaction(async (tx) => {
		const actor = { actor: "staff", actorId: staffId } as const;
		const receipt = await commandReceipt(
			tx,
			config,
			actor,
			input,
			`assessment-correct:${id}`,
		);
		const [scope] = await tx
			.select()
			.from(interviewRound)
			.where(assignedWhere(id, staffId));
		if (!scope) throw new InterviewProblem(404, "not_found");
		await lockCandidacy(tx, scope.driveId, scope.candidateId);
		if ((await lockStaff(tx, staffId, config.domains))?.role !== "panelist")
			throw new InterviewProblem(403, "forbidden");
		const workflow = await readCandidacyWorkflow(tx, scope);
		const affectedId =
			!receipt.previous && scope.level === "l1"
				? workflow.progress?.currentL2RoundId
				: null;
		const ids = [scope.id];
		if (affectedId) {
			const [affected] = await tx
				.select()
				.from(interviewRound)
				.where(
					and(
						eq(interviewRound.id, affectedId),
						eq(interviewRound.level, "l2"),
						eq(interviewRound.qualifyingL1RoundId, scope.id),
					),
				);
			if (affected) {
				await lockResources(tx, affected.invitedEmail, affected.panelistId);
				ids.push(affected.id);
			}
		}
		const locked = await tx
			.select()
			.from(interviewRound)
			.where(inArray(interviewRound.id, ids))
			.orderBy(asc(interviewRound.id))
			.for("update");
		const round = locked.find(
			(row) => row.id === scope.id && row.panelistId === staffId,
		);
		if (!round) throw new InterviewProblem(404, "not_found");
		if (receipt.previous) {
			if (!receipt.matches)
				throw new InterviewProblem(409, "idempotency_conflict");
			return { id: receipt.previous.resourceId };
		}
		if (round.level === "l2" && workflow.pending)
			throw new InterviewProblem(409, "pending_feedback_review");
		const previous = await readSubmittedVersion(tx, round.id);
		const assessment = await roundAssessment(tx, round.id);
		if (
			!previous ||
			!assessment ||
			!(await canCorrectSubmission(tx, round, previous, workflow))
		)
			throw new InterviewProblem(409, "invalid_transition");
		if (input.expectedVersionId !== previous.id)
			throw new InterviewProblem(409, "feedback_version_changed", {
				assessment: await assignedAssessmentView(tx, round, assessment),
			});
		validateRatings(input.scorecard, assessment.criteria);
		if (input.scorecard.ratings.length !== assessment.criteria.skills.length)
			throw new InterviewProblem(409, "assessment_incomplete");
		validateDecision(round, input.scorecard.decision);
		const now = currentTime(config);
		const [version] = await tx
			.insert(interviewAssessmentVersion)
			.values({
				...input.scorecard,
				roundId: round.id,
				version: previous.version + 1,
				previousVersionId: previous.id,
				reviewedL1VersionId: previous.reviewedL1VersionId,
				correctionReason: input.reason,
				authorId: staffId,
				submittedAt: now,
			})
			.returning({ id: interviewAssessmentVersion.id });
		const revision = round.revision + 1;
		await tx
			.update(interviewRound)
			.set({ revision })
			.where(eq(interviewRound.id, round.id));
		const reviewId =
			round.level === "l1"
				? await recordL1Correction(
						tx,
						actor,
						round,
						locked.find((row) => row.id === affectedId),
						workflow,
						previous,
						version.id,
						input.scorecard.decision,
						now,
					)
				: undefined;
		await advanceWorkflow(
			tx,
			round,
			round.level === "l1" ? { l1VersionId: version.id } : undefined,
		);
		await recordEvent(
			tx,
			actor,
			round,
			"assessment_corrected",
			revision,
			round.id,
			{ assessmentVersionId: version.id, feedbackReviewId: reviewId },
		);
		await receipt.record(version.id);
		return version;
	});
}

async function recordL1Correction(
	tx: Transaction,
	actor: Actor,
	l1: RoundRow,
	l2: RoundRow | undefined,
	workflow: CandidacyWorkflow,
	previous: SubmittedVersion,
	versionId: string,
	nextDecision: SubmittedVersion["decision"],
	now: Date,
) {
	if (workflow.pending) {
		await tx
			.update(interviewFeedbackReview)
			.set({ revision: workflow.pending.revision + 1 })
			.where(eq(interviewFeedbackReview.id, workflow.pending.id));
		return workflow.pending.id;
	}
	if (!l2 || previous.decision !== "pass") return undefined;
	const kind = nextDecision === "pass" ? "handoff_updated" : "pass_reversed";
	const submittedL2 =
		l2.state === "feedback_submitted"
			? await readSubmittedVersion(tx, l2.id)
			: null;
	const [review] = await tx
		.insert(interviewFeedbackReview)
		.values({
			driveId: l1.driveId,
			candidateId: l1.candidateId,
			kind,
			createdAt: now,
			l1RoundId: l1.id,
			previousL1VersionId: previous.id,
			triggerL1VersionId: versionId,
			affectedL2RoundId: l2.id,
			affectedL2VersionId: submittedL2?.id,
		})
		.returning({ id: interviewFeedbackReview.id });
	if (
		kind === "pass_reversed" &&
		unresolved.some((state) => state === l2.state)
	) {
		const revision = l2.revision + 1;
		await tx
			.update(interviewRound)
			.set({
				state: "cancelled",
				revision,
				closedAt: l2.closedAt ?? now,
				cancelledAt: now,
				cancellationCode: "l1_pass_reversed",
			})
			.where(eq(interviewRound.id, l2.id));
		await revokeAdmission(tx, l2.id, now);
		await recordEvent(
			tx,
			actor,
			l2,
			"cancel_l1_pass_reversed",
			revision,
			l2.id,
			{ assessmentVersionId: versionId, feedbackReviewId: review.id },
		);
	}
	return review.id;
}

async function requireVersionReader(
	tx: Transaction,
	config: InterviewConfig,
	staffId: string,
	role: "hr" | "panelist" | "director",
	roundId: string,
) {
	if ((await getStaff(tx, staffId, config.domains))?.role !== role)
		throw new InterviewProblem(403, "forbidden");
	const [round] = await tx
		.select()
		.from(interviewRound)
		.where(
			role === "panelist"
				? assignedWhere(roundId, staffId)
				: and(
						eq(interviewRound.id, roundId),
						eq(interviewRound.state, "feedback_submitted"),
					),
		);
	if (!round) throw new InterviewProblem(404, "not_found");
	return round;
}

export function listAssessmentVersions(
	database: Database,
	config: InterviewConfig,
	staffId: string,
	role: "hr" | "panelist" | "director",
	roundId: string,
	page: number,
) {
	return database.transaction(
		async (tx) => {
			await requireVersionReader(tx, config, staffId, role, roundId);
			const pageSize = 20;
			const versions = await tx
				.select({
					id: interviewAssessmentVersion.id,
					version: interviewAssessmentVersion.version,
					decision: interviewAssessmentVersion.decision,
					previousVersionId: interviewAssessmentVersion.previousVersionId,
					reviewedL1VersionId: interviewAssessmentVersion.reviewedL1VersionId,
					correctionReason: interviewAssessmentVersion.correctionReason,
					submittedAt: interviewAssessmentVersion.submittedAt,
					author: { id: user.id, name: user.name },
				})
				.from(interviewAssessmentVersion)
				.innerJoin(user, eq(user.id, interviewAssessmentVersion.authorId))
				.where(eq(interviewAssessmentVersion.roundId, roundId))
				.orderBy(desc(interviewAssessmentVersion.version))
				.limit(pageSize + 1)
				.offset((page - 1) * pageSize);
			return {
				page,
				hasNext: versions.length > pageSize,
				items: versions.slice(0, pageSize).map((version) => ({
					...version,
					submittedAt: version.submittedAt.toISOString(),
				})),
			};
		},
		{ isolationLevel: "repeatable read", accessMode: "read only" },
	);
}

export function getAssessmentVersion(
	database: Database,
	config: InterviewConfig,
	staffId: string,
	role: "hr" | "panelist" | "director",
	roundId: string,
	versionId: string,
) {
	return database.transaction(
		async (tx): Promise<z.infer<typeof assessmentVersionDetailSchema>> => {
			const round = await requireVersionReader(
				tx,
				config,
				staffId,
				role,
				roundId,
			);
			const submitted = await readSubmittedVersion(tx, roundId, versionId);
			if (!submitted) throw new InterviewProblem(404, "not_found");
			const [snapshot] = await tx
				.select({ criteria: interviewAssessment.criteria })
				.from(interviewAssessment)
				.where(eq(interviewAssessment.roundId, roundId));
			return {
				criteria: snapshot.criteria,
				submitted,
				l1Handoff: await readL1Handoff(tx, round, submitted),
			};
		},
		{ isolationLevel: "repeatable read", accessMode: "read only" },
	);
}
