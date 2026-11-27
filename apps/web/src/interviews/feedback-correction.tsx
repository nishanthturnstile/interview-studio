import {
	type AssessmentCriteria,
	type AssessmentView,
	assessmentReasonSchema,
	assessmentScorecardSchema,
	type correctAssessmentSchema,
	interviewResultSchema,
	type Round,
} from "@studio/contracts";
import { type FormEvent, useEffect, useId, useRef, useState } from "react";
import type { z } from "zod";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field, FieldLabel } from "@/components/ui/field";
import { Textarea } from "@/components/ui/textarea";
import { InterviewRequestError, interviewRequest, useCommandKey } from "./api";
import { AssessmentNavigation } from "./assessment-navigation";
import { InterviewAlert } from "./display";
import {
	limitText,
	type ScorecardInput,
	ScorecardInputs,
	SubmittedScorecard,
} from "./scorecard";

export function FeedbackCorrection({
	path,
	level,
	criteria,
	current,
	allowed,
	onError,
	onSaved,
	onCancel,
}: {
	path: string;
	level: Round;
	criteria: AssessmentCriteria;
	current: NonNullable<AssessmentView["submitted"]>;
	allowed: boolean;
	onError: (error: unknown) => void;
	onSaved: () => Promise<void>;
	onCancel: () => void;
}) {
	const [expectedVersionId, setExpectedVersionId] = useState(current.id);
	const [content, setContent] = useState<ScorecardInput>({
		ratings: current.ratings,
		decision: current.decision,
		rationale: current.rationale,
	});
	const [reason, setReason] = useState("");
	const [edited, setEdited] = useState(false);
	const [pending, setPending] = useState(false);
	const [retry, setRetry] = useState<z.infer<typeof correctAssessmentSchema>>();
	const [error, setError] = useState<unknown>();
	const reasonId = useId();
	const heading = useRef<HTMLHeadingElement>(null);
	useEffect(() => heading.current?.focus(), []);
	const withKey = useCommandKey();
	const scorecard = assessmentScorecardSchema.safeParse(content);
	const why = assessmentReasonSchema.safeParse(reason);
	const stale = current.id !== expectedVersionId;
	const ready =
		allowed &&
		!stale &&
		scorecard.success &&
		scorecard.data.ratings.length === criteria.skills.length &&
		why.success;
	async function submit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		if (pending) return;
		const request =
			retry ??
			(ready &&
				withKey({
					expectedVersionId,
					reason: why.data,
					scorecard: scorecard.data,
				}));
		if (!request) return;
		setPending(true);
		setError(undefined);
		try {
			await interviewRequest(`${path}/correct`, interviewResultSchema, {
				data: request,
			});
			await onSaved();
		} catch (error) {
			setError(error);
			onError(error);
			setRetry(
				error instanceof InterviewRequestError && error.status < 500
					? undefined
					: request,
			);
		} finally {
			setPending(false);
		}
	}
	return (
		<form
			className="flex flex-col gap-4 border-t pt-4"
			onSubmit={submit}
			aria-label="Correct feedback"
		>
			<AssessmentNavigation dirty={edited || reason !== ""} saving={pending} />
			<h3 className="font-semibold" tabIndex={-1} ref={heading}>
				Correct feedback
			</h3>
			{stale && (
				<Alert variant="warning">
					<AlertTitle>A newer version was submitted</AlertTitle>
					<AlertDescription className="min-w-0 space-y-3">
						<SubmittedScorecard criteria={criteria} submitted={current} />
						{allowed && !retry && (
							<Button
								type="button"
								size="sm"
								variant="outline"
								onClick={() => {
									setExpectedVersionId(current.id);
									setError(undefined);
								}}
							>
								Keep my correction
							</Button>
						)}
					</AlertDescription>
				</Alert>
			)}
			{!allowed && (
				<p role="status" className="text-sm">
					This scorecard is now read-only.
				</p>
			)}
			<ScorecardInputs
				criteria={criteria}
				level={level}
				content={content}
				onChange={(value) => {
					setContent(value);
					setEdited(true);
				}}
				disabled={pending || Boolean(retry) || !allowed}
			/>
			<Field>
				<FieldLabel htmlFor={reasonId}>Correction reason</FieldLabel>
				<Textarea
					id={reasonId}
					rows={3}
					maxLength={4_000}
					value={reason}
					disabled={pending || Boolean(retry) || !allowed}
					onChange={(event) => setReason(limitText(event.target.value, 2_000))}
				/>
			</Field>
			{error !== undefined && <InterviewAlert error={error} />}
			<div className="flex flex-wrap gap-2">
				<Button type="submit" disabled={pending || (!retry && !ready)}>
					{pending ? "Saving…" : retry ? "Retry correction" : "Save correction"}
				</Button>
				{retry && (
					<Button
						type="button"
						variant="outline"
						disabled={pending}
						onClick={() => setRetry(undefined)}
					>
						Edit correction
					</Button>
				)}
				<Button
					type="button"
					variant="ghost"
					disabled={pending}
					onClick={onCancel}
				>
					Cancel
				</Button>
			</div>
		</form>
	);
}
