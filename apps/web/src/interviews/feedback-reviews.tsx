import {
	type AssessmentVersionMetadata,
	assessmentReasonSchema,
	type FeedbackResolutionAction,
	type FeedbackResolutionOutcome,
	type FeedbackReviewDetail,
	feedbackReviewDetailSchema,
	feedbackReviewListSchema,
	interviewResultSchema,
	type resolveFeedbackReviewSchema,
} from "@studio/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { type FormEvent, useId, useState } from "react";
import type { z } from "zod";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
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
import { AssessmentVersionCard } from "./assessment-versions";
import { InterviewAlert, InterviewEmpty, InterviewLoading } from "./display";
import { InterviewSheetForm } from "./hr-actions";
import { feedbackReviewKey, invalidateHrInterviews } from "./hr-queries";
import { decisionLabels, limitText, textClass } from "./scorecard";

const kindLabels = {
	pass_reversed: "L1 pass reversed",
	handoff_updated: "L1 feedback updated",
};
const resolutions: Record<FeedbackResolutionAction, string> = {
	apply_l1: "Apply L1 decision",
	reinstate_l2: "Reinstate L2 feedback",
	rebook_l2: "Allow a fresh L2 booking",
};
const outcomes: Record<FeedbackResolutionOutcome, string> = {
	do_not_proceed: "Close this candidacy with Do not proceed.",
	schedule_l1: "Make this candidacy eligible for a fresh L1 booking.",
	schedule_l2: "Make this candidacy eligible for a fresh L2 booking.",
	selected: "Restore Selected as the hiring decision.",
	not_selected: "Restore Not selected as the hiring decision.",
};

const reviewPath = "/staff/interviews/reviews";

export function FeedbackReviewInbox({
	page,
	onPage,
	onOpen,
	updatesOnly = false,
}: {
	page: number;
	onPage: (page: number) => void;
	onOpen: (id: string, button: HTMLButtonElement) => void;
	updatesOnly?: boolean;
}) {
	const request = useQuery({
		queryKey: [...feedbackReviewKey, "inbox", page, updatesOnly],
		queryFn: ({ signal }) =>
			interviewRequest(
				`${reviewPath}?page=${page}${updatesOnly ? "&kind=updates" : ""}`,
				feedbackReviewListSchema,
				{
					signal,
				},
			),
		placeholderData: (previous) => previous,
		refetchOnWindowFocus: "always",
		refetchInterval: ({ state }) =>
			accessDenied(state.error) ? false : 30_000,
		retry: retryInterviewRead,
	});
	const list = accessDenied(request.error) ? undefined : request.data;
	if (
		updatesOnly &&
		!request.error &&
		(request.isPending || (list?.total === 0 && page === 1))
	)
		return null;
	const pageCount = list
		? Math.max(1, Math.ceil(list.total / list.pageSize))
		: 1;
	return (
		<div
			className="flex flex-col gap-3"
			aria-busy={request.isPending || request.isPlaceholderData}
		>
			{updatesOnly && <h2 className="font-semibold">Feedback updates</h2>}
			{request.error && <InterviewAlert error={request.error} />}
			{request.isPending ? (
				<InterviewLoading />
			) : (
				list &&
				(list.items.length ? (
					<ul
						className="divide-y rounded-lg border bg-card"
						aria-label="Feedback reviews and updates"
					>
						{list.items.map((item) => (
							<li
								key={item.id}
								className="flex flex-wrap items-center justify-between gap-x-5 gap-y-2 px-4 py-3.5"
							>
								<div className="min-w-0 [overflow-wrap:anywhere]">
									<p className="font-semibold">{item.candidate.name}</p>
									<p className="text-sm text-muted-foreground">
										{item.drive.title}
									</p>
								</div>
								<div className="flex flex-wrap items-center gap-2">
									<Badge
										variant={item.kind === "pass_reversed" ? "warning" : "info"}
									>
										{kindLabels[item.kind]}
									</Badge>
									<Button
										type="button"
										size="sm"
										variant="outline"
										disabled={request.isPlaceholderData}
										aria-label={`Open ${item.kind === "pass_reversed" ? "feedback review" : "feedback update"} for ${item.candidate.name}`}
										onClick={(event) => onOpen(item.id, event.currentTarget)}
									>
										Open details
									</Button>
								</div>
							</li>
						))}
					</ul>
				) : (
					<InterviewEmpty
						title="No feedback reviews or updates"
						description="L1 corrections that affect an existing L2 appear here."
					/>
				))
			)}
			{list && (page > 1 || pageCount > 1) && (
				<nav
					className="flex flex-wrap items-center justify-between gap-2 text-sm"
					aria-label="Feedback review pages"
				>
					<Button
						type="button"
						variant="outline"
						size="sm"
						disabled={page <= 1 || request.isPlaceholderData}
						onClick={() => onPage(page - 1)}
					>
						Previous
					</Button>
					<p>
						Page {page} of {Math.max(page, pageCount)}
					</p>
					<Button
						type="button"
						variant="outline"
						size="sm"
						disabled={page >= pageCount || request.isPlaceholderData}
						onClick={() => onPage(page + 1)}
					>
						Next
					</Button>
				</nav>
			)}
		</div>
	);
}

function ReviewVersion({
	title,
	version,
	roundId,
}: {
	title: string;
	version: AssessmentVersionMetadata;
	roundId: string;
}) {
	const [open, setOpen] = useState(false);
	const path = `/staff/interviews/${roundId}/assessment`;
	return (
		<details
			className="min-w-0 space-y-2 rounded-md border p-3"
			onToggle={(event) => setOpen(event.currentTarget.open)}
		>
			<summary className="cursor-pointer [overflow-wrap:anywhere]">
				<span className="font-semibold">{title}</span> · Version{" "}
				{version.version} · {decisionLabels[version.decision]}
			</summary>
			{open && (
				<>
					<AssessmentVersionCard
						path={path}
						queryKey={["hr-interviews", "assessment", roundId]}
						versionId={version.id}
					/>
					<Link
						to="/staff/interviews"
						search={{ tab: "queue", booking: roundId, version: version.id }}
						className="inline-block text-sm underline"
					>
						Open this scorecard
					</Link>
				</>
			)}
		</details>
	);
}

export function FeedbackReviewSheet({
	id,
	busy,
	setBusy,
}: {
	id: string;
	busy: boolean;
	setBusy: (busy: boolean) => void;
}) {
	const client = useQueryClient();
	const path = `${reviewPath}/${id}`;
	const queryKey = [...feedbackReviewKey, "detail", id];
	const request = useQuery({
		queryKey,
		queryFn: ({ signal }) =>
			interviewRequest(path, feedbackReviewDetailSchema, { signal }),
		refetchOnWindowFocus: "always",
		refetchInterval: ({ state }) => (accessDenied(state.error) ? false : 8_000),
		retry: retryInterviewRead,
	});
	const detail = accessDenied(request.error) ? undefined : request.data;
	if (!detail)
		return (
			<InterviewSheetForm
				title="Feedback review"
				description="Interview feedback"
				footer={null}
			>
				{request.error ? (
					<>
						<InterviewAlert error={request.error} />
						<Button
							variant="outline"
							type="button"
							onClick={() => void request.refetch()}
						>
							Try again
						</Button>
					</>
				) : (
					<InterviewLoading />
				)}
			</InterviewSheetForm>
		);
	return (
		<FeedbackReviewForm
			detail={detail}
			path={path}
			busy={busy}
			setBusy={setBusy}
			onChanged={async (error) => {
				const latest =
					error instanceof InterviewRequestError
						? error.problem?.review
						: undefined;
				if (latest)
					client.setQueryData<FeedbackReviewDetail>(queryKey, (current) =>
						current && current.revision > latest.revision ? current : latest,
					);
				await invalidateHrInterviews(client);
			}}
		/>
	);
}

function FeedbackReviewForm({
	detail,
	path,
	busy,
	setBusy,
	onChanged,
}: {
	detail: FeedbackReviewDetail;
	path: string;
	busy: boolean;
	setBusy: (busy: boolean) => void;
	onChanged: (error?: unknown) => Promise<void>;
}) {
	const [expected, setExpected] = useState({
		expectedRevision: detail.revision,
		expectedL1VersionId: detail.latestL1.id,
	});
	const [reason, setReason] = useState("");
	const [error, setError] = useState<unknown>();
	const [retry, setRetry] =
		useState<z.infer<typeof resolveFeedbackReviewSchema>>();
	const reasonId = useId();
	const withKey = useCommandKey();
	const resolution = detail.availableResolution;
	const infoUnread =
		detail.kind === "handoff_updated" && !detail.acknowledgment;
	const stale =
		expected.expectedRevision !== detail.revision ||
		expected.expectedL1VersionId !== detail.latestL1.id;
	const valid = assessmentReasonSchema.safeParse(reason);
	async function submit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		if (busy) return;
		const input =
			retry ??
			(resolution && !stale && valid.success
				? withKey({
						...expected,
						reason: valid.data,
						action: resolution.action,
					})
				: null);
		if (!infoUnread && !input) return;
		setBusy(true);
		setError(undefined);
		try {
			await interviewRequest(
				infoUnread ? `${path}/acknowledge` : `${path}/resolve`,
				interviewResultSchema,
				{ data: infoUnread ? withKey({}) : input },
			);
			setRetry(undefined);
			await onChanged();
		} catch (error) {
			setError(error);
			setRetry(
				input &&
					(!(error instanceof InterviewRequestError) || error.status >= 500)
					? input
					: undefined,
			);
			await onChanged(error);
		} finally {
			setBusy(false);
		}
	}
	return (
		<InterviewSheetForm
			title={detail.candidate.name}
			description={detail.drive.title}
			onSubmit={submit}
			status={
				<Badge
					variant={
						detail.resolution || detail.acknowledgment
							? "muted"
							: detail.kind === "pass_reversed"
								? "warning"
								: "info"
					}
				>
					{kindLabels[detail.kind]}
				</Badge>
			}
			footer={
				infoUnread ? (
					<Button type="submit" disabled={busy}>
						{busy ? "Saving…" : "Mark as read"}
					</Button>
				) : (
					resolution && (
						<>
							{retry && (
								<Button
									type="button"
									variant="outline"
									disabled={busy}
									onClick={() => setRetry(undefined)}
								>
									Edit resolution
								</Button>
							)}
							<Button
								type="submit"
								disabled={busy || (!retry && (stale || !valid.success))}
							>
								{busy
									? "Saving…"
									: retry
										? "Retry resolution"
										: resolutions[resolution.action]}
							</Button>
						</>
					)
				)
			}
		>
			{error !== undefined && <InterviewAlert error={error} />}
			<ReviewVersion
				title="L1 before the correction"
				version={detail.previousL1}
				roundId={detail.l1RoundId}
			/>
			{detail.triggerL1.id !== detail.latestL1.id && (
				<ReviewVersion
					title="L1 that triggered this review"
					version={detail.triggerL1}
					roundId={detail.l1RoundId}
				/>
			)}
			<ReviewVersion
				title={
					detail.resolution
						? "L1 applied at resolution"
						: "L1 after the correction"
				}
				version={detail.latestL1}
				roundId={detail.l1RoundId}
			/>
			<section className="space-y-2 text-sm">
				<h3 className="font-semibold">
					Affected L2 · Attempt {detail.l2.attempt}
				</h3>
				<Link
					to="/staff/interviews"
					search={{ tab: "queue", booking: detail.l2.id }}
					className="text-sm underline"
				>
					Open L2 booking
				</Link>
				{detail.l2Version && (
					<ReviewVersion
						title="Submitted L2 feedback"
						version={detail.l2Version}
						roundId={detail.l2.id}
					/>
				)}
			</section>
			{resolution && (
				<div className="space-y-3 border-t pt-4">
					{stale && (
						<Alert variant="warning">
							<AlertTitle>The review has a newer L1 version</AlertTitle>
							<AlertDescription>
								<Button
									type="button"
									variant="outline"
									size="sm"
									disabled={busy || Boolean(retry)}
									onClick={() => {
										setExpected({
											expectedRevision: detail.revision,
											expectedL1VersionId: detail.latestL1.id,
										});
										setError(undefined);
									}}
								>
									Use the current L1 decision
								</Button>
							</AlertDescription>
						</Alert>
					)}
					<h3 className="font-semibold">Result of resolution</h3>
					<p className="text-sm">{outcomes[resolution.outcome]}</p>
					<Field>
						<FieldLabel htmlFor={reasonId}>Resolution reason</FieldLabel>
						<Textarea
							id={reasonId}
							rows={3}
							maxLength={4_000}
							value={reason}
							disabled={busy || Boolean(retry)}
							onChange={(event) =>
								setReason(limitText(event.target.value, 2_000))
							}
						/>
					</Field>
				</div>
			)}
			{detail.resolution && (
				<section className="space-y-2 border-t pt-4" role="status">
					<h3 className="font-semibold">Review resolved</h3>
					<p className="text-sm">
						{resolutions[detail.resolution.action]} ·{" "}
						{detail.resolution.resolvedBy.name} ·{" "}
						{new Date(detail.resolution.resolvedAt).toLocaleString()}
					</p>
					<p className={`${textClass} text-sm`}>{detail.resolution.reason}</p>
				</section>
			)}
			{detail.acknowledgment && (
				<p className="text-sm" role="status">
					Read by {detail.acknowledgment.readBy.name} ·{" "}
					{new Date(detail.acknowledgment.readAt).toLocaleString()}
				</p>
			)}
		</InterviewSheetForm>
	);
}
