import {
	type BookInterview,
	type EligibleInterviewCandidate,
	type HrInterview,
	hrInterviewSchema,
	type InterviewCandidacySnapshot,
	type InterviewError,
	type InterviewMeeting,
	type InterviewPanelist,
	type InterviewPreferences,
	interviewInvitationSchema,
	interviewPreferencesSchema,
	interviewResultSchema,
	meetingSchema,
	noShowPartySchema,
	withdrawCandidacySchema,
} from "@studio/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
	CalendarDays,
	ChevronDown,
	Copy,
	Link2,
	MapPin,
	RefreshCw,
} from "lucide-react";
import {
	type FormEvent,
	type ReactNode,
	useEffect,
	useId,
	useRef,
	useState,
} from "react";
import { Alert, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuGroup,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import {
	Select,
	SelectContent,
	SelectGroup,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import {
	SheetDescription,
	SheetFooter,
	SheetHeader,
	SheetTitle,
} from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import {
	accessDenied,
	InterviewRequestError,
	interviewRequest,
	useCommandKey,
	useInterviewResource,
} from "./api";
import { HrScorecard } from "./assessment";
import {
	AttendanceSummary,
	ConflictWarning,
	experienceLabel,
	InterviewAlert,
	InterviewLoading,
	InterviewStatus,
	localSlot,
	MeetingLink,
	ScheduleCard,
	scheduleLabel,
} from "./display";
import {
	MeetingFields,
	PanelistPicker,
	SlotFields,
	type SlotFieldsValue,
	useSlotPreview,
} from "./forms";

import {
	bookingEligibilityQuery,
	hrBookingQuery,
	invalidateHrInterviews,
} from "./hr-queries";

const preferencePath = "/staff/settings/interviews";

type SheetWriteState = {
	busy: boolean;
	setBusy: (busy: boolean) => void;
};

export function InterviewSheetForm({
	title,
	description,
	status,
	children,
	footer,
	conflicts,
	onSubmit,
}: {
	title: string;
	description: ReactNode;
	status?: ReactNode;
	children: ReactNode;
	footer: ReactNode;
	conflicts?: InterviewError["conflicts"];
	onSubmit?: (event: FormEvent<HTMLFormElement>) => void;
}) {
	const heading = useRef<HTMLHeadingElement>(null);
	useEffect(() => {
		heading.current?.focus();
	}, []);

	return (
		<form className="flex min-h-0 flex-1 flex-col" onSubmit={onSubmit}>
			<SheetHeader className="gap-1.5 border-b p-4 pr-12 sm:p-6 sm:pr-14">
				<div className="flex flex-wrap items-center gap-x-3 gap-y-2">
					<SheetTitle
						ref={heading}
						tabIndex={-1}
						className="text-2xl tracking-tight [overflow-wrap:anywhere] focus:outline-none"
					>
						{title}
					</SheetTitle>
					{status}
				</div>
				<SheetDescription className="[overflow-wrap:anywhere]">
					{description}
				</SheetDescription>
			</SheetHeader>
			<div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto overscroll-contain p-4 sm:p-6">
				{children}
			</div>
			{conflicts && (
				<div className="max-h-[30dvh] shrink-0 overflow-y-auto border-t px-4 py-2 sm:px-6">
					<ConflictWarning conflicts={conflicts} />
				</div>
			)}
			{footer && (
				<SheetFooter className="shrink-0 border-t bg-card pb-[max(1rem,env(safe-area-inset-bottom))] sm:flex-row sm:items-center sm:justify-end sm:px-6">
					{footer}
				</SheetFooter>
			)}
		</form>
	);
}

export function BookingSheet({
	candidate,
	onBook,
	onWithdraw,
	busy,
	setBusy,
}: {
	candidate: EligibleInterviewCandidate;
	onBook: (id: string) => void;
	onWithdraw: () => void;
} & SheetWriteState) {
	const prefs = useInterviewResource(
		preferencePath,
		interviewPreferencesSchema,
	);
	if (prefs.data)
		return (
			<BookingForm
				candidate={candidate}
				preferences={prefs.data}
				onBook={onBook}
				onWithdraw={onWithdraw}
				busy={busy}
				setBusy={setBusy}
			/>
		);
	return (
		<InterviewSheetForm
			title={`Schedule ${candidate.level.toUpperCase()}`}
			description={candidate.name}
			footer={null}
		>
			{prefs.error !== undefined ? (
				<>
					<InterviewAlert error={prefs.error} />
					<Button type="button" variant="outline" onClick={prefs.refresh}>
						Try again
					</Button>
				</>
			) : (
				<InterviewLoading />
			)}
		</InterviewSheetForm>
	);
}

export function WithdrawCandidacySheet({
	candidate,
	onWithdraw,
	onBack,
	busy,
	setBusy,
}: {
	candidate: EligibleInterviewCandidate;
	onWithdraw: () => void;
	onBack?: () => void;
} & SheetWriteState) {
	const query = bookingEligibilityQuery(candidate.drive.id, candidate.id);
	const eligibility = useQuery(query);
	const denied = accessDenied(eligibility.error);
	const current = !eligibility.error ? eligibility.data : undefined;
	const [reason, setReason] = useState("");
	const [retry, setRetry] =
		useState<ReturnType<typeof withdrawCandidacySchema.parse>>();
	const [error, setError] = useState<unknown>();
	const withKey = useCommandKey();
	async function submit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		if (busy || denied || (!current && !retry)) return;
		const input =
			retry ??
			(current &&
				withKey({
					revision: current.revision,
					workflowRevision: current.workflowRevision,
					reason: reason.trim(),
				}));
		const parsed = withdrawCandidacySchema.safeParse(input);
		if (!parsed.success) return;
		setError(undefined);
		setBusy(true);
		try {
			await interviewRequest(
				`/staff/interviews/candidacies/${candidate.drive.id}/${candidate.id}/withdraw`,
				interviewResultSchema,
				{ data: parsed.data },
			);
			onWithdraw();
		} catch (problem) {
			setError(problem);
			if (problem instanceof InterviewRequestError && problem.status < 500) {
				setRetry(undefined);
				void eligibility.refetch();
			} else {
				setRetry(parsed.data);
			}
		} finally {
			setBusy(false);
		}
	}
	return (
		<InterviewSheetForm
			title="Withdraw candidacy"
			description={current?.name ?? candidate.name}
			onSubmit={submit}
			footer={
				<>
					{onBack && (
						<Button
							type="button"
							variant="outline"
							disabled={busy}
							onClick={onBack}
						>
							Back to booking
						</Button>
					)}
					<Button
						type="submit"
						variant="destructive"
						disabled={
							busy || denied || (!retry && (!current || !reason.trim()))
						}
					>
						{busy
							? "Withdrawing…"
							: retry
								? "Retry withdrawal"
								: "Withdraw candidate"}
					</Button>
				</>
			}
		>
			<p className="text-sm text-muted-foreground">{candidate.drive.title}</p>
			<fieldset disabled={busy || Boolean(retry) || !current}>
				<ReasonField value={reason} onChange={setReason} />
			</fieldset>
			{eligibility.isPending && <InterviewLoading />}
			{(denied
				? eligibility.error
				: (error ?? (!retry && eligibility.error))) && (
				<InterviewAlert
					error={denied ? eligibility.error : (error ?? eligibility.error)}
				/>
			)}
		</InterviewSheetForm>
	);
}

function useMutationFeedback() {
	const [error, setError] = useState<unknown>();
	const [conflict, setConflict] = useState<InterviewError>();
	return {
		error,
		conflict,
		report(error: unknown) {
			setError(error);
			if (error instanceof InterviewRequestError && error.status < 500) {
				const problem = error.problem;
				setConflict(problem?.error === "slot_conflict" ? problem : undefined);
			}
			// A lost response can follow a committed write. Keep its acknowledged payload retryable.
		},
		clear() {
			setError(undefined);
			setConflict(undefined);
		},
	};
}

function BookingForm({
	candidate,
	preferences,
	onBook,
	onWithdraw,
	busy,
	setBusy,
}: {
	candidate: EligibleInterviewCandidate;
	preferences: InterviewPreferences;
	onBook: (id: string) => void;
	onWithdraw: () => void;
} & SheetWriteState) {
	const client = useQueryClient();
	const criteriaHeadingId = useId();
	const isL2 = candidate.level === "l2";
	const [settings, setSettings] = useState(preferences);
	const [slot, setSlot] = useState<SlotFieldsValue>({
		date: "",
		time: "",
		duration: String(preferences.duration),
	});
	const [meeting, setMeeting] = useState<InterviewMeeting>({
		mode: "virtual",
		teamsUrl: null,
	});
	const [panelist, setPanelist] = useState<InterviewPanelist | null>(null);
	const [withdrawing, setWithdrawing] = useState(false);
	const [candidacy, setCandidacy] =
		useState<InterviewCandidacySnapshot>(candidate);
	const [workflowRevision, setWorkflowRevision] = useState(
		candidate.workflowRevision,
	);
	const [acceptedCriteria, setAcceptedCriteria] = useState(candidate.criteria);
	const [updatedCriteria, setUpdatedCriteria] = useState(candidate.criteria);
	const [retryBooking, setRetryBooking] = useState<BookInterview>();
	const { error, conflict, report, clear } = useMutationFeedback();
	const withKey = useCommandKey();
	const problem =
		error instanceof InterviewRequestError ? error.problem : undefined;
	const scope = { driveId: candidate.drive.id, candidateId: candidate.id };
	const eligibility = useQuery(
		bookingEligibilityQuery(scope.driveId, scope.candidateId),
	);
	const denied = accessDenied(eligibility.error);
	const ineligible =
		eligibility.error instanceof InterviewRequestError &&
		eligibility.error.status === 409;
	const current =
		!denied && !ineligible && eligibility.data?.level === candidate.level
			? eligibility.data
			: undefined;
	const eligibilityError =
		eligibility.error ??
		new InterviewRequestError(409, { error: "round_not_eligible" });
	const criteria = retryBooking
		? acceptedCriteria
		: [current?.criteria ?? candidate.criteria, updatedCriteria].reduce(
				(latest, next) => (next.revision > latest.revision ? next : latest),
				acceptedCriteria,
			);
	const reviewed = criteria.reviewedAt !== null && criteria.skills.length > 0;
	const criteriaChanged = criteria.revision !== acceptedCriteria.revision;
	const preview = useSlotPreview(withdrawing ? null : slot, settings.timeZone);
	async function submit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		if (busy || denied || (!current && !retryBooking)) return;
		let attempted = retryBooking;
		if (!attempted) {
			if (!reviewed || criteriaChanged) return;
			const validMeeting = meetingSchema.safeParse(meeting);
			if (
				!preview.slot ||
				!preview.data ||
				!panelist ||
				!validMeeting.success
			) {
				report(new InterviewRequestError(400, { error: "invalid_input" }));
				return;
			}
			attempted = withKey({
				...scope,
				candidateRevision: candidacy.revision,
				workflowRevision,
				skillRevision: acceptedCriteria.revision,
				level: candidate.level,
				panelistId: panelist.id,
				preferenceRevision: settings.revision,
				slot: preview.slot,
				meeting: validMeeting.data,
				acknowledge: conflict?.acknowledge,
			});
		}
		setBusy(true);
		try {
			const { id } = await interviewRequest(
				"/staff/interviews",
				interviewResultSchema,
				{ data: attempted },
			);
			onBook(id);
		} catch (error) {
			report(error);
			if (
				error instanceof InterviewRequestError &&
				["pending_feedback_review", "round_not_eligible"].includes(
					error.message,
				)
			)
				void eligibility.refetch();
			setRetryBooking(
				error instanceof InterviewRequestError && error.status < 500
					? undefined
					: attempted,
			);
			if (error instanceof InterviewRequestError && error.problem?.criteria) {
				setUpdatedCriteria(error.problem.criteria);
				void invalidateHrInterviews(client);
			}
			if (
				error instanceof InterviewRequestError &&
				error.problem?.workflowRevision !== undefined
			) {
				setWorkflowRevision(error.problem.workflowRevision);
				void invalidateHrInterviews(client);
			}
			if (error instanceof InterviewRequestError && error.problem?.candidacy) {
				setCandidacy(error.problem.candidacy);
				void invalidateHrInterviews(client);
			}
			if (
				error instanceof InterviewRequestError &&
				error.problem?.preferences
			) {
				setSettings(error.problem.preferences);
				setSlot((current) => ({ ...current, offset: undefined }));
			}
			if (
				error instanceof InterviewRequestError &&
				error.problem?.error === "panelist_ineligible"
			)
				setPanelist(null);
		} finally {
			setBusy(false);
		}
	}
	if (withdrawing) {
		return (
			<WithdrawCandidacySheet
				candidate={candidate}
				onWithdraw={onWithdraw}
				onBack={() => setWithdrawing(false)}
				busy={busy}
				setBusy={setBusy}
			/>
		);
	}
	return (
		<InterviewSheetForm
			title={`Schedule ${candidate.level.toUpperCase()}`}
			description={
				<span className="font-medium text-foreground">{candidacy.name}</span>
			}
			onSubmit={submit}
			conflicts={conflict?.conflicts}
			footer={
				<div className="flex w-full flex-wrap items-center justify-between gap-2">
					<Button
						type="button"
						variant="ghost"
						size="sm"
						className="text-muted-foreground"
						onClick={() => {
							if (retryBooking) setRetryBooking(undefined);
							else setWithdrawing(true);
							clear();
						}}
						disabled={busy || (!current && !retryBooking)}
					>
						{retryBooking ? "Edit booking" : "Withdraw candidacy"}
					</Button>
					<Button
						type="submit"
						disabled={
							busy ||
							denied ||
							(!retryBooking &&
								(!current ||
									!panelist ||
									!preview.data ||
									!reviewed ||
									criteriaChanged))
						}
					>
						{busy
							? "Booking…"
							: retryBooking
								? "Retry booking"
								: conflict?.acknowledge
									? "Book anyway"
									: "Book interview"}
					</Button>
				</div>
			}
		>
			<dl className="grid gap-1.5 rounded-md border bg-muted/40 px-3.5 py-3 text-sm [overflow-wrap:anywhere]">
				<div>
					<dt className="sr-only">Email</dt>
					<dd className="font-medium">{candidacy.email}</dd>
				</div>
				<div>
					<dt className="sr-only">Drive and experience</dt>
					<dd className="flex flex-wrap gap-x-2 gap-y-0.5 text-muted-foreground">
						<span>{candidate.drive.title}</span>
						<span aria-hidden="true">·</span>
						<span>{experienceLabel(candidacy.years)}</span>
					</dd>
				</div>
			</dl>
			{!retryBooking &&
				!current &&
				(eligibility.isPending ? (
					<p role="status">Checking booking eligibility…</p>
				) : (
					<InterviewAlert error={eligibilityError} />
				))}
			{current?.qualifyingL1RoundId && (
				<HrScorecard roundId={current.qualifyingL1RoundId} bookingPreview />
			)}
			<section
				aria-labelledby={criteriaHeadingId}
				className={cn(
					"flex min-w-0 flex-col items-start gap-2 text-sm",
					isL2 && "border-y py-3.5",
				)}
			>
				<div className="flex w-full flex-wrap items-center justify-between gap-2">
					<h3
						id={criteriaHeadingId}
						className={cn("font-semibold", isL2 && "text-base")}
					>
						{isL2 ? "L2 scorecard criteria" : "Scorecard criteria"}
					</h3>
					{isL2 && reviewed && <Badge variant="muted">Reviewed</Badge>}
				</div>
				{reviewed ? (
					<>
						{isL2 && (
							<p className="text-muted-foreground">
								These skills are saved with the L2 booking.
							</p>
						)}
						<ol
							role={isL2 ? "list" : undefined}
							className={cn(
								"min-w-0 [overflow-wrap:anywhere]",
								isL2
									? "flex max-w-full flex-wrap gap-1.5"
									: "list-decimal space-y-1 pl-5",
							)}
						>
							{criteria.skills.map((skill) => (
								<li
									key={skill.id}
									className={
										isL2
											? "max-w-full rounded-md border bg-muted/60 px-2.5 py-1 font-medium"
											: undefined
									}
								>
									{skill.name}
								</li>
							))}
						</ol>
						{criteriaChanged && (
							<Button
								type="button"
								size="sm"
								variant="outline"
								disabled={busy}
								onClick={() => {
									setAcceptedCriteria(criteria);
									clear();
								}}
							>
								Use current criteria
							</Button>
						)}
					</>
				) : (
					<>
						<p role="status" className="text-muted-foreground">
							Review the drive’s skills before booking this round.
						</p>
						<Link
							to="/staff/drives/$driveId"
							params={{ driveId: candidate.drive.id }}
							hash="scorecard-skills"
							target="_blank"
							rel="noopener"
							className={buttonVariants({ variant: "outline", size: "sm" })}
						>
							Open drive skills
						</Link>
					</>
				)}
			</section>
			<fieldset disabled={busy || Boolean(retryBooking)}>
				<FieldGroup>
					<PanelistPicker
						value={panelist}
						onChange={(value) => {
							setPanelist(value);
							clear();
						}}
					/>
					<SlotFields
						value={slot}
						timeZone={settings.timeZone}
						preview={preview}
						onChange={(value) => {
							setSlot(value);
							clear();
						}}
					/>
					<MeetingFields
						value={meeting}
						onChange={(value) => {
							setMeeting(value);
							clear();
						}}
					/>
				</FieldGroup>
			</fieldset>
			{error !== undefined &&
				!problem?.conflicts &&
				(current ||
					retryBooking ||
					eligibilityError.message !== problem?.error) && (
					<InterviewAlert error={error} />
				)}
			{problem?.preferences && (
				<p className="text-sm text-muted-foreground">
					Your current default is {settings.duration} minutes. Review the
					booking’s duration above.
				</p>
			)}
		</InterviewSheetForm>
	);
}

const hrActions = {
	meeting: "Edit meeting details",
	reschedule: "Reschedule",
	reassign: "Reassign panelist",
	replace_link: "Replace Studio link",
	cancel: "Cancel booking",
	cancel_unavailable_panelist: "Cancel for unavailable panelist",
	no_show: "Mark no-show",
	withdraw: "Withdraw candidacy",
	end: "Close round",
} as const;

type HrAction = keyof typeof hrActions;

const confirmations: Partial<Record<HrAction, string>> = {
	replace_link:
		"A new Studio link will replace the current one. Send the replacement to both participants.",
	reschedule:
		"Saving a new slot also replaces the Studio link. Update the Teams invitation after saving.",
	cancel:
		"This cancels the booking and ends access through its link. The candidate can be scheduled again.",
	cancel_unavailable_panelist:
		"This keeps the attempt in History and lets you book the candidate again at the same level.",
	no_show:
		"This records the absence and closes the booking. The candidate can be scheduled again.",
	withdraw:
		"This closes the booking and removes the candidate from the scheduling queue.",
	end: "This ends the active interview for both participants and moves it to Awaiting feedback.",
};

function ReasonField({
	value,
	onChange,
}: {
	value: string;
	onChange: (value: string) => void;
}) {
	const id = useId();
	return (
		<Field>
			<FieldLabel htmlFor={id}>Reason</FieldLabel>
			<Textarea
				id={id}
				rows={3}
				maxLength={300}
				required
				value={value}
				onChange={(event) => onChange(event.target.value)}
			/>
		</Field>
	);
}

function availableActions(round: HrInterview): HrAction[] {
	if (round.pendingReviewId) return [];
	if (round.state === "active") return ["end", "withdraw"];
	if (round.canCancelUnavailablePanelist)
		return ["cancel_unavailable_panelist"];
	if (round.state !== "scheduled") return [];
	return [
		"meeting",
		"reschedule",
		"reassign",
		"replace_link",
		"cancel",
		...(round.canMarkNoShow ? ["no_show" as const] : []),
		"withdraw",
	];
}

function ManageForm({
	action,
	round,
	onBack,
	onSaved,
	onStale,
	busy,
	setBusy,
}: {
	action: HrAction;
	round: HrInterview;
	onBack: () => void;
	onSaved: (action: HrAction) => void;
	onStale: () => void;
} & SheetWriteState) {
	const [revision, setRevision] = useState(round.revision);
	const [slot, setSlot] = useState<SlotFieldsValue>(() => localSlot(round));
	const preview = useSlotPreview(
		action === "reschedule" ? slot : null,
		round.timeZone,
	);
	const [meeting, setMeeting] = useState(round.meeting);
	const [panelist, setPanelist] = useState<InterviewPanelist | null>(
		round.panelist,
	);
	const [reason, setReason] = useState("");
	const [absent, setAbsent] = useState<"candidate" | "panelist" | "both">(
		"candidate",
	);
	const absentId = useId();
	const [latest, setLatest] = useState<HrInterview>();
	const { error, conflict, report, clear } = useMutationFeedback();
	const withKey = useCommandKey();
	const problem =
		error instanceof InterviewRequestError ? error.problem : undefined;
	const current = latest && latest.revision > round.revision ? latest : round;
	const reviewRequired = current.revision !== revision;
	const actionUnavailable = !availableActions(current).includes(action);
	const destructive = [
		"cancel",
		"cancel_unavailable_panelist",
		"withdraw",
		"end",
		"no_show",
	].includes(action);
	const submitLabels: Record<HrAction, string> = {
		meeting: "Save meeting details",
		reschedule: "Save new time",
		reassign: "Save panelist",
		replace_link: hrActions.replace_link,
		cancel: hrActions.cancel,
		cancel_unavailable_panelist: hrActions.cancel_unavailable_panelist,
		no_show: hrActions.no_show,
		withdraw: "Withdraw candidate",
		end: hrActions.end,
	};
	function values() {
		switch (action) {
			case "meeting":
				return meetingSchema.safeParse(meeting).success ? { meeting } : null;
			case "reschedule":
				return preview.slot && preview.data
					? { slot: preview.slot, acknowledge: conflict?.acknowledge }
					: null;
			case "reassign":
				return panelist
					? { panelistId: panelist.id, acknowledge: conflict?.acknowledge }
					: null;
			case "withdraw":
			case "cancel_unavailable_panelist":
				return { reason };
			case "no_show":
				return { reason, absent };
			default:
				return {};
		}
	}
	async function submit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		if (busy || reviewRequired || actionUnavailable) return;
		const data = values();
		if (!data) {
			report(new InterviewRequestError(400, { error: "invalid_input" }));
			return;
		}
		setBusy(true);
		try {
			await interviewRequest(
				`/staff/interviews/${round.id}/commands`,
				interviewResultSchema,
				{ data: withKey({ action, revision, ...data }) },
			);
			onSaved(action);
		} catch (error) {
			report(error);
			if (error instanceof InterviewRequestError) {
				const current = hrInterviewSchema.safeParse(error.problem?.round);
				if (current.success) setLatest(current.data);
				if (
					current.success ||
					error.problem?.error === "pending_feedback_review"
				)
					onStale();
				if (error.problem?.error === "panelist_ineligible") setPanelist(null);
			}
		} finally {
			setBusy(false);
		}
	}

	return (
		<InterviewSheetForm
			title={hrActions[action]}
			description={round.candidate.name}
			onSubmit={submit}
			conflicts={conflict?.conflicts}
			footer={
				<>
					<Button
						type="button"
						variant="outline"
						onClick={onBack}
						disabled={busy}
					>
						Back to booking
					</Button>
					<Button
						type="submit"
						variant={destructive ? "destructive" : "default"}
						disabled={
							busy ||
							reviewRequired ||
							actionUnavailable ||
							(action === "reassign" && !panelist) ||
							(action === "reschedule" && !preview.data)
						}
					>
						{busy
							? "Saving…"
							: conflict?.acknowledge
								? "Save anyway"
								: submitLabels[action]}
					</Button>
				</>
			}
		>
			{(latest || reviewRequired || actionUnavailable) && (
				<section aria-label="Current booking" className="flex flex-col gap-3">
					<div className="flex items-center justify-between gap-2">
						<h3 className="font-semibold">Current booking</h3>
						<InterviewStatus state={current.state} />
					</div>
					<ScheduleCard round={current} title="Current time and location">
						{current.meeting.mode === "virtual" && current.meeting.teamsUrl && (
							<p className="[overflow-wrap:anywhere] text-muted-foreground">
								{current.meeting.teamsUrl}
							</p>
						)}
					</ScheduleCard>
					<p>
						Current panelist: {current.panelist.name} ({current.panelist.email})
					</p>
					{current.pendingReviewId && (
						<Alert variant="warning">
							<AlertTitle>Pending HR review</AlertTitle>
						</Alert>
					)}
					{actionUnavailable ? (
						<p>This action is no longer available for the current booking.</p>
					) : (
						reviewRequired && (
							<Button
								type="button"
								variant="outline"
								className="self-start"
								onClick={() => {
									setRevision(current.revision);
									clear();
								}}
							>
								Continue with my changes
							</Button>
						)
					)}
				</section>
			)}
			{confirmations[action] && (
				<p className="text-muted-foreground">{confirmations[action]}</p>
			)}
			<fieldset
				disabled={busy || actionUnavailable}
				className="flex flex-col gap-5"
			>
				{action === "meeting" && (
					<MeetingFields
						value={meeting}
						allowMode={false}
						onChange={(value) => {
							setMeeting(value);
							clear();
						}}
					/>
				)}
				{action === "reassign" && (
					<PanelistPicker
						value={panelist}
						onChange={(value) => {
							setPanelist(value);
							clear();
						}}
					/>
				)}
				{action === "reschedule" && (
					<SlotFields
						value={slot}
						timeZone={round.timeZone}
						preview={preview}
						onChange={(value) => {
							setSlot(value);
							clear();
						}}
					/>
				)}
				{action === "no_show" && (
					<Field>
						<FieldLabel htmlFor={absentId}>Who was absent?</FieldLabel>
						<Select
							items={[
								{ value: "candidate", label: "Candidate" },
								{ value: "panelist", label: "Panelist" },
								{ value: "both", label: "Both" },
							]}
							value={absent}
							onValueChange={(value) => {
								const parsed = noShowPartySchema.safeParse(value);
								if (parsed.success) setAbsent(parsed.data);
							}}
						>
							<SelectTrigger id={absentId}>
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								<SelectGroup>
									<SelectItem value="candidate">Candidate</SelectItem>
									<SelectItem value="panelist">Panelist</SelectItem>
									<SelectItem value="both">Both</SelectItem>
								</SelectGroup>
							</SelectContent>
						</Select>
					</Field>
				)}
				{(action === "no_show" ||
					action === "withdraw" ||
					action === "cancel_unavailable_panelist") && (
					<ReasonField value={reason} onChange={setReason} />
				)}
			</fieldset>
			{error !== undefined && !problem?.conflicts && (
				<InterviewAlert error={error} />
			)}
		</InterviewSheetForm>
	);
}

export function HrRoundDetail({
	id,
	versionId,
	busy,
	setBusy,
}: { id: string; versionId?: string } & SheetWriteState) {
	const client = useQueryClient();
	const request = useQuery(hrBookingQuery(id));
	const error = request.error ?? undefined;
	const round = accessDenied(error) ? undefined : request.data;
	const refresh = () => void request.refetch();
	const [action, setAction] = useState<HrAction>();
	const [notice, setNotice] = useState("");
	const [copyError, setCopyError] = useState<unknown>();
	const [manualCopy, setManualCopy] = useState<{
		text: string;
		revision: number;
	}>();
	const [copying, setCopying] = useState(false);
	async function copy(kind: "link" | "text") {
		if (!round) return;
		setCopying(true);
		setManualCopy(undefined);
		setCopyError(undefined);
		try {
			const invite = await interviewRequest(
				`/staff/interviews/${id}/invitation`,
				interviewInvitationSchema,
			);
			try {
				await navigator.clipboard.writeText(invite[kind]);
				setNotice(
					kind === "link" ? "Studio link copied." : "Invitation copied.",
				);
			} catch {
				setManualCopy({ text: invite[kind], revision: round.revision });
			}
		} catch (error) {
			setCopyError(error);
		} finally {
			setCopying(false);
		}
	}
	if (!round)
		return (
			<InterviewSheetForm
				title="Booking details"
				description="Interview"
				footer={null}
			>
				{error !== undefined ? (
					<>
						<InterviewAlert error={error} />
						<Button type="button" variant="outline" onClick={refresh}>
							Try again
						</Button>
					</>
				) : (
					<InterviewLoading />
				)}
			</InterviewSheetForm>
		);
	if (action)
		return (
			<ManageForm
				action={action}
				round={round}
				busy={busy}
				setBusy={setBusy}
				onBack={() => setAction(undefined)}
				onStale={refresh}
				onSaved={(changed) => {
					setAction(undefined);
					setNotice(
						changed === "replace_link" || changed === "reschedule"
							? "The Studio link changed. Copy the new invitation and update Teams."
							: "Booking updated.",
					);
					void invalidateHrInterviews(client, id);
				}}
			/>
		);
	const scheduled = round.state === "scheduled";
	const active = round.state === "active";
	const actions = availableActions(round).filter(
		(name) => name !== "meeting" && name !== "reschedule" && name !== "end",
	);
	function openAction(name: HrAction) {
		setNotice("");
		setManualCopy(undefined);
		setAction(name);
	}
	const meeting = round.meeting;
	return (
		<InterviewSheetForm
			title={round.candidate.name}
			description={`${round.level.toUpperCase()} · ${round.drive.title} · Attempt ${round.attempt}`}
			status={<InterviewStatus state={round.state} />}
			footer={
				(scheduled || active) && (
					<>
						<Button
							type="button"
							variant="outline"
							onClick={() => void copy("link")}
							disabled={copying}
						>
							<Link2 data-icon="inline-start" />
							Copy Studio link
						</Button>
						<Button
							type="button"
							onClick={() => void copy("text")}
							disabled={copying}
						>
							<Copy data-icon="inline-start" />
							Copy invitation
						</Button>
					</>
				)
			}
		>
			{round.pendingReviewId && (
				<Alert variant="warning">
					<AlertTitle>
						{round.reviewAffectsRound
							? "Pending HR review"
							: "Candidacy pending HR review"}
					</AlertTitle>
					<Link
						to="/staff/interviews"
						search={{ tab: "queue", review: round.pendingReviewId }}
						className="text-sm underline"
					>
						Open feedback review
					</Link>
				</Alert>
			)}
			{round.decision && (
				<HrScorecard roundId={round.id} versionId={versionId} />
			)}
			{round.qualifyingL1RoundId &&
				(scheduled || active || round.state === "awaiting_feedback") && (
					<HrScorecard roundId={round.qualifyingL1RoundId} bookingPreview />
				)}
			{notice && (
				<Alert role="status" variant="success">
					<AlertTitle>{notice}</AlertTitle>
				</Alert>
			)}
			{copyError !== undefined && <InterviewAlert error={copyError} />}
			{manualCopy?.revision === round.revision && (scheduled || active) && (
				<Field>
					<FieldLabel htmlFor="manual-invite">
						Copy this invitation text
					</FieldLabel>
					<Textarea
						id="manual-invite"
						value={manualCopy.text}
						readOnly
						rows={6}
						onFocus={(event) => event.target.select()}
					/>
				</Field>
			)}
			<section
				aria-label="Interview time"
				className="rounded-md border bg-muted/40 p-4"
			>
				<div className="flex items-start gap-3">
					<span className="grid size-9 shrink-0 place-items-center rounded-md bg-accent text-accent-foreground">
						<CalendarDays className="size-4" aria-hidden="true" />
					</span>
					<div className="min-w-0">
						<h3 className="text-xs font-medium text-muted-foreground">
							Interview time
						</h3>
						<p className="mt-1 font-semibold tabular-nums">
							{scheduleLabel(round.start, round.end, round.timeZone)}
						</p>
						<p className="mt-0.5 text-muted-foreground">
							{round.duration} minutes
						</p>
					</div>
				</div>
				{scheduled && (
					<Button
						type="button"
						variant="outline"
						size="sm"
						className="mt-3"
						onClick={() => openAction("reschedule")}
					>
						Reschedule
					</Button>
				)}
			</section>
			<section aria-label="Meeting" className="flex flex-col gap-2">
				<h3 className="font-semibold">Meeting</h3>
				{meeting.mode === "virtual" ? (
					meeting.teamsUrl ? (
						<MeetingLink url={meeting.teamsUrl} />
					) : (
						<p className="text-muted-foreground">Meeting link pending</p>
					)
				) : (
					<p className="flex items-start gap-2 [overflow-wrap:anywhere]">
						<MapPin
							className="mt-0.5 size-4 shrink-0 text-muted-foreground"
							aria-hidden="true"
						/>
						<span>{meeting.room}</span>
					</p>
				)}
				{scheduled && (
					<Button
						type="button"
						size="sm"
						variant="ghost"
						className="self-start"
						onClick={() => openAction("meeting")}
					>
						Edit meeting details
					</Button>
				)}
			</section>
			<Separator />
			<dl className="grid gap-4 [overflow-wrap:anywhere] sm:grid-cols-2">
				<div>
					<dt className="text-xs text-muted-foreground">Candidate</dt>
					<dd className="mt-1 font-medium">{round.candidate.email}</dd>
					<dd className="text-muted-foreground">
						{experienceLabel(round.candidate.years)}
					</dd>
				</div>
				<div>
					<dt className="text-xs text-muted-foreground">Assigned panelist</dt>
					<dd className="mt-1 font-medium">{round.panelist.name}</dd>
					<dd className="text-muted-foreground">{round.panelist.email}</dd>
				</div>
				<div className="sm:col-span-2">
					<dt className="mb-1 text-xs text-muted-foreground">Attendance</dt>
					<dd>
						<AttendanceSummary round={round} />
					</dd>
					{round.confirmedProfile && (
						<dd className="mt-1 text-muted-foreground">
							Confirmed by candidate: {round.confirmedProfile.name},{" "}
							{experienceLabel(round.confirmedProfile.years)}
						</dd>
					)}
				</div>
				{round.reason && (
					<div className="sm:col-span-2">
						<dt className="text-xs text-muted-foreground">Reason</dt>
						<dd className="mt-1">
							{round.absent && (
								<span className="capitalize">{round.absent} absent. </span>
							)}
							{round.reason}
						</dd>
					</div>
				)}
			</dl>
			<Separator />
			<div className="flex flex-wrap items-center justify-between gap-2">
				<div className="flex flex-wrap items-center gap-2">
					{active && (
						<Button
							type="button"
							size="sm"
							variant="outline"
							onClick={() => openAction("end")}
						>
							Close round
						</Button>
					)}
					{actions.length > 0 && (
						<DropdownMenu>
							<DropdownMenuTrigger
								render={<Button type="button" variant="outline" size="sm" />}
							>
								Manage booking <ChevronDown data-icon="inline-end" />
							</DropdownMenuTrigger>
							<DropdownMenuContent className="min-w-45">
								<DropdownMenuGroup>
									{actions.map((name) => (
										<DropdownMenuItem
											key={name}
											variant={
												name === "cancel" || name === "withdraw"
													? "destructive"
													: "default"
											}
											onClick={() => openAction(name)}
										>
											{hrActions[name]}
										</DropdownMenuItem>
									))}
								</DropdownMenuGroup>
							</DropdownMenuContent>
						</DropdownMenu>
					)}
				</div>
				<Button type="button" size="sm" variant="ghost" onClick={refresh}>
					<RefreshCw
						data-icon="inline-start"
						className={
							request.isFetching ? "motion-safe:animate-spin" : undefined
						}
					/>
					Refresh details
				</Button>
			</div>
			{error !== undefined && <InterviewAlert error={error} />}
		</InterviewSheetForm>
	);
}
