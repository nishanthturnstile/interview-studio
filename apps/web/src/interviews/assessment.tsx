import {
	type AssessmentCriteria,
	type AssessmentDraft,
	type AssessmentView,
	assessmentDraftSchema,
	assessmentScorecardSchema,
	assessmentViewSchema,
	hrAssessmentSchema,
	interviewResultSchema,
	type Round,
} from "@studio/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { LockKeyhole, Plus, Trash2 } from "lucide-react";
import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field, FieldLabel } from "@/components/ui/field";
import { Textarea } from "@/components/ui/textarea";
import {
	accessDenied,
	InterviewRequestError,
	interviewRequest,
	retryInterviewRead,
	useCommandKey,
} from "./api";
import { AssessmentNavigation } from "./assessment-navigation";
import {
	AssessmentVersionCard,
	AssessmentVersionHistory,
} from "./assessment-versions";
import { InterviewAlert, InterviewLoading } from "./display";
import { FeedbackCorrection } from "./feedback-correction";
import { invalidateHrInterviews } from "./hr-queries";
import {
	limitText,
	ScorecardDecisionBadge,
	ScorecardFields,
	ScorecardInputs,
	ScorecardSummary,
	SubmittedScorecard,
	textClass,
} from "./scorecard";

function PrivateReadback({ content }: { content: AssessmentDraft }) {
	return (
		<div className="flex flex-col gap-2 text-sm">
			{content.questions.length > 0 && (
				<ol className="list-decimal space-y-1 pl-5">
					{content.questions.map((question) => (
						<li className={textClass} key={question.id}>
							{question.text}
						</li>
					))}
				</ol>
			)}
			<p className={textClass}>{content.notes || "No private notes"}</p>
		</div>
	);
}

export function HrScorecard({
	roundId,
	bookingPreview,
	versionId,
}: {
	roundId: string;
	bookingPreview?: boolean;
	versionId?: string;
}) {
	const client = useQueryClient();
	const headingId = useId();
	const path = `/staff/interviews/${roundId}/assessment`;
	const queryKey = ["hr-interviews", "assessment", roundId];
	const request = useQuery({
		queryKey,
		queryFn: ({ signal }) =>
			interviewRequest(path, hrAssessmentSchema, {
				signal,
				cached: client.getQueryData(queryKey),
			}),
		refetchOnWindowFocus: "always",
		retry: retryInterviewRead,
		refetchInterval: ({ state }) => (accessDenied(state.error) ? false : 8_000),
	});
	const scorecard = accessDenied(request.error) ? undefined : request.data;
	const decision = scorecard?.submitted.decision;
	return (
		<section
			aria-labelledby={headingId}
			className={
				bookingPreview
					? "flex min-w-0 flex-col gap-2.5 rounded-xl border bg-card px-4 pt-4 pb-1"
					: "flex flex-col gap-2"
			}
		>
			<div className="flex flex-wrap items-center justify-between gap-2">
				<h3 id={headingId} className="font-semibold">
					{bookingPreview ? "L1 submitted scorecard" : "Submitted scorecard"}
				</h3>
				{bookingPreview && decision && (
					<ScorecardDecisionBadge decision={decision} />
				)}
			</div>
			{versionId && !accessDenied(request.error) ? (
				<AssessmentVersionCard
					path={path}
					queryKey={queryKey}
					versionId={versionId}
				/>
			) : (
				<>
					{request.error && <InterviewAlert error={request.error} />}
					{scorecard ? (
						bookingPreview ? (
							<ScorecardSummary {...scorecard} />
						) : (
							<>
								<SubmittedScorecard {...scorecard} />
								<AssessmentVersionHistory
									path={path}
									queryKey={queryKey}
									headId={scorecard.submitted.id}
								/>
							</>
						)
					) : (
						request.isPending && <InterviewLoading />
					)}
				</>
			)}
		</section>
	);
}

function PanelistHandoff({
	handoff,
	title = "L1 handoff",
	children,
}: {
	handoff: NonNullable<AssessmentView["l1Handoff"]>;
	title?: string;
	children?: ReactNode;
}) {
	const headingId = useId();
	return (
		<section
			aria-labelledby={headingId}
			className="min-w-0 rounded-xl border bg-card"
		>
			<div className="flex flex-col gap-2.5 px-4 pt-4 pb-1 sm:px-5">
				<div className="flex flex-wrap items-center justify-between gap-2">
					<h2 id={headingId} className="text-lg font-bold tracking-tight">
						{title}
					</h2>
					<ScorecardDecisionBadge decision={handoff.submitted.decision} />
				</div>
				<ScorecardSummary {...handoff} />
			</div>
			{children}
		</section>
	);
}

export function PanelistAssessment({
	roundId,
	staffId,
	level,
	scheduled,
	attemptRevision,
	onSubmitted,
}: {
	roundId: string;
	staffId: string;
	level: Round;
	scheduled: boolean;
	attemptRevision: number;
	onSubmitted: () => void;
}) {
	const client = useQueryClient();
	const path = `/staff/my-interviews/${roundId}/assessment`;
	const queryKey = ["assigned-assessment", staffId, roundId];
	const request = useQuery({
		queryKey,
		queryFn: async ({ signal }) => {
			const assessment = await interviewRequest(path, assessmentViewSchema, {
				signal,
				cached: client.getQueryData(queryKey),
			});
			if (assessment.status !== "initialize") return assessment;
			try {
				await interviewRequest(`${path}/initialize`, interviewResultSchema, {
					signal,
					data: { commandId: crypto.randomUUID() },
				});
			} catch (error) {
				if (
					!(error instanceof InterviewRequestError) ||
					!["skills_need_review", "invalid_transition"].includes(error.message)
				)
					throw error;
			}
			return interviewRequest(path, assessmentViewSchema, { signal });
		},
		retry: false,
		refetchOnWindowFocus: "always",
		refetchInterval: ({ state }) => (accessDenied(state.error) ? false : 8_000),
	});
	const view = accessDenied(request.error) ? undefined : request.data;
	const { refetch } = request;
	const assessedRevision = view?.attemptRevision;
	useEffect(() => {
		if (assessedRevision !== undefined && assessedRevision < attemptRevision)
			void refetch();
	}, [assessedRevision, attemptRevision, refetch]);
	if (view?.status === "unavailable") return null;
	const scheduledHandoff = scheduled ? view?.l1Handoff : undefined;
	const heading = (
		<h2 className="text-xl font-bold tracking-tight">
			{scheduled
				? "L1 handoff"
				: level === "l2"
					? "L2 manual assessment"
					: "Manual assessment"}
		</h2>
	);
	const editor = !scheduled && view?.criteria && view.draft && (
		<AssessmentEditor
			view={view}
			level={level}
			path={path}
			queryKey={queryKey}
			criteria={view.criteria}
			draft={view.draft}
			heading={heading}
			onSubmitted={onSubmitted}
		/>
	);
	return (
		<div className="flex min-w-0 flex-col gap-4 [&_:is(input,select,textarea,button)]:scroll-mb-32">
			{!scheduledHandoff && !editor && heading}
			{request.error && <InterviewAlert error={request.error} />}
			{!view && !request.error && <InterviewLoading />}
			{(view?.status === "initialize" ||
				(!view && request.error && !accessDenied(request.error))) && (
				<Button
					className="self-start"
					variant="outline"
					onClick={() => void request.refetch()}
				>
					Load assessment
				</Button>
			)}
			{view?.status === "skills_need_review" && (
				<Alert variant="warning">
					<AlertTitle>Waiting for reviewed skills</AlertTitle>
					<AlertDescription>
						Ask HR to review the drive’s scorecard skills.
					</AlertDescription>
				</Alert>
			)}
			{scheduledHandoff && <PanelistHandoff handoff={scheduledHandoff} />}
			{editor}
		</div>
	);
}

function AssessmentEditor({
	view,
	level,
	path,
	queryKey,
	criteria,
	draft,
	heading,
	onSubmitted,
}: {
	view: AssessmentView;
	level: Round;
	path: string;
	queryKey: string[];
	criteria: AssessmentCriteria;
	draft: NonNullable<AssessmentView["draft"]>;
	heading: ReactNode;
	onSubmitted: () => void;
}) {
	const client = useQueryClient();
	const [edits, setEdits] = useState<{
		content: AssessmentDraft;
		revision: number;
	}>();
	const [busy, setBusy] = useState<"save" | "submit">();
	const [error, setError] = useState<unknown>();
	const [notice, setNotice] = useState("");
	const [acknowledgedL1, setAcknowledgedL1] = useState<string>();
	const [correcting, setCorrecting] = useState(false);
	const correctButton = useRef<HTMLButtonElement>(null);
	const saveKey = useCommandKey();
	const submitKey = useCommandKey();
	const resultFocus = useRef<HTMLHeadingElement>(null);
	const submittedHere = useRef(false);
	const questionFocus = useRef<string>(null);
	const prefix = useId();
	const content = edits?.content ?? draft.content;
	const stale = edits !== undefined && edits.revision !== draft.revision;
	const handoff = view.l1Handoff;
	const handoffVersionId = handoff?.submitted.id;
	const handoffAcknowledged =
		level === "l1" ||
		Boolean(handoffVersionId && acknowledgedL1 === handoffVersionId);
	const complete =
		assessmentScorecardSchema.safeParse(content).success &&
		content.ratings.length === criteria.skills.length;
	const draftStatus = stale
		? "Newer draft available"
		: edits
			? "Unsaved changes"
			: notice || (draft.updatedAt ? "Draft saved" : "Draft not yet saved");
	const submissionHint = !view.canSubmit
		? "End the interview to submit feedback."
		: !handoffAcknowledged
			? "Acknowledge the L1 scorecard before submitting."
			: !complete
				? "Rate every skill and add a decision and rationale."
				: edits
					? "Save your draft before submitting."
					: "Ready to submit";

	function edit(update: (previous: AssessmentDraft) => AssessmentDraft) {
		setEdits((previous) => ({
			content: update(previous?.content ?? draft.content),
			revision: previous?.revision ?? draft.revision,
		}));
		setNotice("");
	}
	useEffect(() => {
		if (questionFocus.current) {
			document.getElementById(`${prefix}-${questionFocus.current}`)?.focus();
			questionFocus.current = null;
		}
	});
	useEffect(() => {
		if (submittedHere.current && view.submitted) {
			submittedHere.current = false;
			resultFocus.current?.focus();
			onSubmitted();
			void invalidateHrInterviews(client);
		}
	}, [client, onSubmitted, view.submitted]);
	function handleWriteError(error: unknown) {
		setError(error);
		const latest =
			error instanceof InterviewRequestError
				? error.problem?.assessment
				: undefined;
		if (latest)
			client.setQueryData<AssessmentView>(queryKey, (current) => {
				if (
					current &&
					(current.attemptRevision > latest.attemptRevision ||
						(current.draft?.revision ?? 0) > (latest.draft?.revision ?? 0) ||
						(current.attemptRevision === latest.attemptRevision &&
							(current.l1Handoff?.submitted.version ?? 0) >
								(latest.l1Handoff?.submitted.version ?? 0)))
				)
					return current;
				return latest;
			});
	}
	async function save() {
		if (!edits || stale || busy || !view.canEdit) return;
		const parsed = assessmentDraftSchema.safeParse(content);
		if (!parsed.success) {
			setError(new InterviewRequestError(400, { error: "invalid_input" }));
			return;
		}
		setBusy("save");
		setError(undefined);
		try {
			await interviewRequest(`${path}/draft`, interviewResultSchema, {
				method: "PATCH",
				data: saveKey({ draftRevision: edits.revision, content: parsed.data }),
			});
			await client.cancelQueries({ queryKey });
			const revision = edits.revision + 1;
			client.setQueryData<AssessmentView>(queryKey, (current) => {
				if (!current?.draft || current.draft.revision >= revision)
					return current;
				return {
					...current,
					revisionTag: undefined,
					draft: { ...current.draft, revision, content: parsed.data },
				};
			});
			setEdits((current) =>
				!current || current === edits ? undefined : { ...current, revision },
			);
			setNotice("Draft saved");
		} catch (problem) {
			handleWriteError(problem);
		} finally {
			setBusy(undefined);
			void client.invalidateQueries({ queryKey });
		}
	}
	async function submit() {
		if (edits || busy || !complete || !view.canSubmit || !handoffAcknowledged)
			return;
		submittedHere.current = true;
		setBusy("submit");
		setError(undefined);
		try {
			await interviewRequest(`${path}/submit`, interviewResultSchema, {
				data: submitKey({
					draftRevision: draft.revision,
					attemptRevision: view.attemptRevision,
					reviewedL1VersionId: handoffVersionId,
				}),
			});
		} catch (problem) {
			handleWriteError(problem);
		} finally {
			await client.invalidateQueries({ queryKey });
			setBusy(undefined);
		}
	}
	return (
		<>
			<AssessmentNavigation dirty={Boolean(edits)} saving={Boolean(busy)} />
			{handoff && (
				<PanelistHandoff
					handoff={handoff}
					title={view.submitted ? "L1 handoff used for submission" : undefined}
				>
					{view.canEdit && (
						<div className="space-y-2 rounded-b-xl border-t bg-muted/40 px-4 py-3.5 sm:px-5">
							{acknowledgedL1 && !handoffAcknowledged && (
								<p
									role="status"
									className="rounded-md bg-warning px-3 py-2 text-sm text-warning-foreground"
								>
									The L1 scorecard was updated. Review this version before
									submitting.
								</p>
							)}
							<label className="flex w-fit cursor-pointer items-start gap-3 text-sm has-disabled:cursor-default">
								<input
									type="checkbox"
									checked={handoffAcknowledged}
									disabled={busy === "submit"}
									aria-labelledby={`${prefix}-handoff-label`}
									aria-describedby={`${prefix}-handoff-hint`}
									className="mt-0.5 size-4 shrink-0 accent-primary"
									onChange={(event) =>
										setAcknowledgedL1(
											event.target.checked ? handoffVersionId : undefined,
										)
									}
								/>
								<span>
									<span
										id={`${prefix}-handoff-label`}
										className="block font-semibold"
									>
										I’ve reviewed this L1 scorecard
									</span>
									<span
										id={`${prefix}-handoff-hint`}
										className="text-muted-foreground"
									>
										Required before submitting L2 feedback.
									</span>
								</span>
							</label>
						</div>
					)}
				</PanelistHandoff>
			)}
			{heading}
			{criteria.source === "after_booking" && (
				<p className="text-sm text-muted-foreground">
					Criteria captured after booking.
				</p>
			)}
			{view.submitted && (
				<section className="flex min-w-0 flex-col gap-2">
					<h3 className="font-semibold" tabIndex={-1} ref={resultFocus}>
						Submitted scorecard
					</h3>
					<SubmittedScorecard criteria={criteria} submitted={view.submitted} />
					<AssessmentVersionHistory
						path={path}
						queryKey={queryKey}
						headId={view.submitted.id}
					/>
					{correcting ? (
						<FeedbackCorrection
							path={path}
							level={level}
							criteria={criteria}
							current={view.submitted}
							allowed={view.canCorrect}
							onError={(error) => {
								handleWriteError(error);
								void client.invalidateQueries({ queryKey });
							}}
							onSaved={async () => {
								await client.invalidateQueries({ queryKey });
								setCorrecting(false);
								resultFocus.current?.focus();
								onSubmitted();
								void invalidateHrInterviews(client);
							}}
							onCancel={() => {
								setCorrecting(false);
								requestAnimationFrame(() => correctButton.current?.focus());
							}}
						/>
					) : (
						view.canCorrect && (
							<Button
								ref={correctButton}
								type="button"
								variant="outline"
								className="self-start"
								onClick={() => setCorrecting(true)}
							>
								Correct feedback
							</Button>
						)
					)}
				</section>
			)}
			{!view.canEdit ? (
				<>
					{!view.submitted && draft.updatedAt && (
						<section
							aria-labelledby={`${prefix}-saved-scorecard`}
							className="flex min-w-0 flex-col gap-2"
						>
							<h3 id={`${prefix}-saved-scorecard`} className="font-semibold">
								Saved draft scorecard
							</h3>
							<ScorecardFields criteria={criteria} content={draft.content} />
						</section>
					)}
					<details className="rounded-md border px-3 py-2">
						<summary className="cursor-pointer font-medium">
							Private questions and notes
						</summary>
						<div className="pt-2">
							<PrivateReadback content={draft.content} />
						</div>
					</details>
				</>
			) : (
				<div className="grid min-w-0 items-start gap-4 @min-[47rem]/round:grid-cols-[minmax(0,1fr)_minmax(17rem,0.48fr)] sm:gap-5">
					<ScorecardInputs
						criteria={criteria}
						level={level}
						content={content}
						disabled={busy === "submit"}
						onChange={(change) =>
							edit((current) => ({ ...current, ...change(current) }))
						}
					/>
					<fieldset
						aria-labelledby={`${prefix}-private-work`}
						disabled={busy === "submit"}
						className="min-w-0 rounded-xl border bg-card"
					>
						<div className="border-b px-4 py-3.5 sm:px-5">
							<h3
								id={`${prefix}-private-work`}
								className="flex items-center gap-2 font-semibold"
							>
								<LockKeyhole
									className="size-4 shrink-0 text-muted-foreground"
									aria-hidden="true"
								/>
								Private questions and notes
							</h3>
							<p className="mt-1 text-sm text-muted-foreground">
								Visible only to you.
							</p>
						</div>
						<div className="space-y-4 px-4 py-4 sm:px-5">
							<Field className="gap-2">
								<FieldLabel htmlFor={`${prefix}-notes`}>
									Private notes
								</FieldLabel>
								<Textarea
									id={`${prefix}-notes`}
									className="field-sizing-fixed resize-y"
									rows={6}
									maxLength={32_000}
									value={content.notes}
									onChange={(event) => {
										const notes = limitText(event.target.value, 16_000);
										edit((current) => ({ ...current, notes }));
									}}
								/>
							</Field>
							{content.questions.map((question, index) => (
								<Field key={question.id}>
									<FieldLabel htmlFor={`${prefix}-${question.id}`}>
										Question {index + 1}
									</FieldLabel>
									<div className="flex items-start gap-2">
										<Textarea
											id={`${prefix}-${question.id}`}
											className="min-w-0 field-sizing-fixed resize-y"
											rows={2}
											maxLength={1_000}
											value={question.text}
											onChange={(event) => {
												const text = limitText(event.target.value, 500);
												edit((current) => ({
													...current,
													questions: current.questions.map((row) =>
														row.id === question.id ? { ...row, text } : row,
													),
												}));
											}}
										/>
										<Button
											type="button"
											variant="ghost"
											size="icon-sm"
											aria-label={`Remove question ${index + 1}`}
											onClick={() => {
												const next =
													content.questions[index + 1] ??
													content.questions[index - 1];
												questionFocus.current = next?.id ?? "add-question";
												edit((current) => ({
													...current,
													questions: current.questions.filter(
														({ id }) => id !== question.id,
													),
												}));
											}}
										>
											<Trash2 />
										</Button>
									</div>
								</Field>
							))}
							<Button
								id={`${prefix}-add-question`}
								variant="outline"
								size="sm"
								disabled={content.questions.length >= 50}
								onClick={() => {
									const id = crypto.randomUUID();
									questionFocus.current = id;
									edit((current) => ({
										...current,
										questions: [...current.questions, { id, text: "" }],
									}));
								}}
							>
								<Plus />
								Add question
							</Button>
						</div>
					</fieldset>
				</div>
			)}
			{!view.canEdit && edits && (
				<details className="min-w-0 space-y-2 rounded-md border px-3 py-2">
					<summary className="cursor-pointer font-medium">
						Your unsaved changes
					</summary>
					<ScorecardFields criteria={criteria} content={edits.content} />
					<PrivateReadback content={edits.content} />
				</details>
			)}
			{error !== undefined && !view.submitted && !stale && (
				<InterviewAlert error={error} />
			)}
			{stale && view.canEdit && (
				<Alert variant="warning">
					<AlertTitle>A newer draft was saved</AlertTitle>
					<AlertDescription>
						<details className="w-full min-w-0 space-y-3">
							<summary className="cursor-pointer">
								Compare with the saved draft
							</summary>
							<ScorecardFields criteria={criteria} content={draft.content} />
							<PrivateReadback content={draft.content} />
							<div className="flex flex-wrap gap-2">
								<Button
									variant="outline"
									size="sm"
									onClick={() => {
										setEdits(undefined);
										setError(undefined);
									}}
								>
									Use saved draft
								</Button>
								<Button
									variant="outline"
									size="sm"
									onClick={() => {
										setEdits({ content, revision: draft.revision });
										setError(undefined);
									}}
								>
									Keep my edits
								</Button>
							</div>
						</details>
					</AlertDescription>
				</Alert>
			)}
			{view.canEdit && (
				<div className="sticky bottom-0 z-10 flex flex-wrap items-center justify-between gap-x-5 gap-y-2 rounded-t-xl border bg-card px-4 pt-2.5 pb-[max(0.625rem,env(safe-area-inset-bottom))] sm:px-5 sm:pt-3 sm:pb-[max(0.75rem,env(safe-area-inset-bottom))]">
					<div role="status" className="min-w-0 text-sm">
						<p className="font-semibold">{draftStatus}</p>
						<p className="text-muted-foreground">{submissionHint}</p>
					</div>
					<div className="flex flex-wrap items-center gap-2">
						<Button
							variant="outline"
							disabled={!edits || stale || Boolean(busy)}
							onClick={() => void save()}
						>
							{busy === "save" ? "Saving…" : "Save draft"}
						</Button>
						{view.canSubmit && (
							<Button
								disabled={
									!complete ||
									!handoffAcknowledged ||
									Boolean(edits) ||
									Boolean(busy)
								}
								onClick={() => void submit()}
							>
								{busy === "submit" ? "Submitting…" : "Submit feedback"}
							</Button>
						)}
					</div>
				</div>
			)}
		</>
	);
}
