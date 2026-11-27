import {
	type AssessmentCriteria,
	type AssessmentDraft,
	type AssessmentScorecard,
	assessmentDecisionSchema,
	assessmentDecisionsByRound,
	assessmentRatingSchema,
	type Round,
	type submittedAssessmentSchema,
} from "@studio/contracts";
import { Check, ChevronDown, MessageSquare } from "lucide-react";
import { useId, useState } from "react";
import type { z } from "zod";
import { Badge } from "@/components/ui/badge";
import { Field, FieldLabel } from "@/components/ui/field";
import { Textarea } from "@/components/ui/textarea";

export const decisionLabels: Record<AssessmentScorecard["decision"], string> = {
	pass: "Pass",
	do_not_proceed: "Do not proceed",
	incomplete: "Incomplete",
	selected: "Selected",
	not_selected: "Not selected",
};
const ratingLabels: Record<
	AssessmentScorecard["ratings"][number]["rating"],
	string
> = {
	below_expectations: "Below expectations",
	meets_expectations: "Meets expectations",
	exceeds_expectations: "Exceeds expectations",
	not_assessed: "Not assessed",
};
const selectClass =
	"h-10 w-full rounded-md border border-input bg-background px-2.5 text-sm focus-visible:outline-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-60";
export const textClass = "whitespace-pre-wrap [overflow-wrap:anywhere]";

export const limitText = (value: string, length: number) =>
	value.length <= length ? value : Array.from(value).slice(0, length).join("");

function ScorecardRatingRows({
	criteria,
	ratings,
}: {
	criteria: AssessmentCriteria;
	ratings: AssessmentDraft["ratings"];
}) {
	const bySkill = new Map(ratings.map((row) => [row.skillId, row]));
	return criteria.skills.map(({ id, name }) => {
		const row = bySkill.get(id);
		return (
			<div
				key={id}
				className="grid gap-1 px-3 py-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.5fr)]"
			>
				<dt className="font-medium [overflow-wrap:anywhere]">{name}</dt>
				<dd>
					{row?.rating ? ratingLabels[row.rating] : "Rating pending"}
					{row?.feedback && (
						<p className={`${textClass} mt-1 text-muted-foreground`}>
							{row.feedback}
						</p>
					)}
				</dd>
			</div>
		);
	});
}

export function ScorecardFields({
	criteria,
	content,
}: {
	criteria: AssessmentCriteria;
	content: Pick<AssessmentDraft, "ratings" | "decision" | "rationale">;
}) {
	return (
		<dl className="divide-y rounded-md border text-sm">
			<ScorecardRatingRows criteria={criteria} ratings={content.ratings} />
			<div className="px-3 py-2">
				<dt className="font-medium">
					{content.decision
						? decisionLabels[content.decision]
						: "Decision pending"}
				</dt>
				{content.rationale && (
					<dd className={`${textClass} mt-1`}>{content.rationale}</dd>
				)}
			</div>
		</dl>
	);
}

export function ScorecardDecisionBadge({
	decision,
}: {
	decision: AssessmentScorecard["decision"];
}) {
	return (
		<Badge variant={decision === "pass" ? "success" : "muted"}>
			{decision === "pass" && <Check aria-hidden="true" />}
			{decisionLabels[decision]}
		</Badge>
	);
}

export function ScorecardSummary({
	criteria,
	submitted,
}: {
	criteria: AssessmentCriteria;
	submitted: z.infer<typeof submittedAssessmentSchema>;
}) {
	return (
		<>
			<p className="text-sm text-muted-foreground [overflow-wrap:anywhere]">
				{submitted.author.name} ·{" "}
				<time dateTime={submitted.submittedAt}>
					{new Date(submitted.submittedAt).toLocaleString(undefined, {
						dateStyle: "medium",
						timeStyle: "short",
					})}
				</time>{" "}
				· Version {submitted.version}
			</p>
			<dl className="space-y-2 rounded-md bg-muted/60 px-3 py-2.5 text-sm">
				<div>
					<dt className="font-semibold">Decision rationale</dt>
					<dd className={`${textClass} mt-0.5`}>{submitted.rationale}</dd>
				</div>
				{submitted.correctionReason && (
					<div>
						<dt className="font-semibold">Correction reason</dt>
						<dd className={`${textClass} mt-0.5`}>
							{submitted.correctionReason}
						</dd>
					</div>
				)}
			</dl>
			<details className="group border-t">
				<summary className="flex min-h-10 cursor-pointer list-none items-center justify-between gap-2 rounded-sm text-sm font-medium hover:text-accent-foreground [&::-webkit-details-marker]:hidden">
					<span>Skill ratings ({criteria.skills.length})</span>
					<ChevronDown
						className="size-4 shrink-0 text-muted-foreground group-open:rotate-180"
						aria-hidden="true"
					/>
				</summary>
				<dl className="divide-y rounded-md border text-sm">
					<ScorecardRatingRows
						criteria={criteria}
						ratings={submitted.ratings}
					/>
				</dl>
			</details>
		</>
	);
}

export function SubmittedScorecard({
	criteria,
	submitted,
}: {
	criteria: AssessmentCriteria;
	submitted: z.infer<typeof submittedAssessmentSchema>;
}) {
	return (
		<div className="flex flex-col gap-2">
			<p className="text-sm text-muted-foreground [overflow-wrap:anywhere]">
				Version {submitted.version} · {submitted.author.name} ·{" "}
				{new Date(submitted.submittedAt).toLocaleString()}
			</p>
			<ScorecardFields criteria={criteria} content={submitted} />
			{submitted.correctionReason && (
				<p className={`${textClass} text-sm text-muted-foreground`}>
					<strong>Correction reason</strong>
					<br />
					{submitted.correctionReason}
				</p>
			)}
		</div>
	);
}

export type ScorecardInput = Pick<
	AssessmentDraft,
	"ratings" | "decision" | "rationale"
>;
type SkillResponse = ScorecardInput["ratings"][number];

function SkillRating({
	name,
	response,
	onChange,
}: {
	name: string;
	response: SkillResponse | undefined;
	onChange: (change: Partial<SkillResponse>) => void;
}) {
	const id = useId();
	const [feedbackOpen, setFeedbackOpen] = useState(Boolean(response?.feedback));
	return (
		<div className="grid min-w-0 gap-x-4 gap-y-1.5 px-4 py-3 @min-[25rem]/scorecard:grid-cols-[minmax(0,1fr)_minmax(11.5rem,43%)] sm:px-5">
			<FieldLabel
				className="self-center [overflow-wrap:anywhere]"
				htmlFor={`${id}-rating`}
			>
				{name}
			</FieldLabel>
			<select
				id={`${id}-rating`}
				className={`${selectClass} @min-[25rem]/scorecard:col-start-2 @min-[25rem]/scorecard:row-span-2 @min-[25rem]/scorecard:row-start-1 @min-[25rem]/scorecard:self-center`}
				value={response?.rating ?? ""}
				onChange={(event) =>
					onChange({
						rating:
							assessmentRatingSchema.safeParse(event.target.value).data ?? null,
					})
				}
			>
				<option value="">Choose a rating</option>
				{assessmentRatingSchema.options.map((rating) => (
					<option key={rating} value={rating}>
						{ratingLabels[rating]}
					</option>
				))}
			</select>
			<button
				type="button"
				aria-expanded={feedbackOpen}
				aria-controls={`${id}-feedback`}
				aria-label={`${feedbackOpen ? "Hide" : response?.feedback ? "View" : "Add"} feedback for ${name}`}
				onClick={() => setFeedbackOpen(!feedbackOpen)}
				className="flex min-h-7 w-fit max-w-full items-center gap-1.5 rounded-sm text-sm font-medium text-muted-foreground hover:text-foreground"
			>
				<MessageSquare className="size-3.5" aria-hidden="true" />
				{feedbackOpen
					? "Hide feedback"
					: response?.feedback
						? "View feedback"
						: "Add feedback"}
				<ChevronDown
					className={`size-3.5 ${feedbackOpen ? "rotate-180" : ""}`}
					aria-hidden="true"
				/>
			</button>
			<div
				id={`${id}-feedback`}
				hidden={!feedbackOpen}
				className="min-w-0 pt-1 @min-[25rem]/scorecard:col-span-2"
			>
				<Textarea
					aria-label={`Feedback for ${name}`}
					placeholder="Optional skill feedback"
					className="field-sizing-fixed resize-y"
					rows={2}
					maxLength={1_000}
					value={response?.feedback ?? ""}
					onChange={(event) =>
						onChange({ feedback: limitText(event.target.value, 500) })
					}
				/>
			</div>
		</div>
	);
}

export function ScorecardInputs({
	criteria,
	level,
	content,
	onChange,
	disabled,
}: {
	criteria: AssessmentCriteria;
	level: Round;
	content: ScorecardInput;
	onChange: (change: (value: ScorecardInput) => ScorecardInput) => void;
	disabled?: boolean;
}) {
	const prefix = useId();
	const ratings = new Map(content.ratings.map((row) => [row.skillId, row]));
	const rated = criteria.skills.filter(
		({ id }) => ratings.get(id)?.rating,
	).length;
	function changeRating(skillId: string, next: Partial<SkillResponse>) {
		onChange((value) => {
			const row = value.ratings.find((rating) => rating.skillId === skillId);
			return {
				...value,
				ratings: [
					...value.ratings.filter((rating) => rating.skillId !== skillId),
					{
						skillId,
						rating: row?.rating ?? null,
						feedback: row?.feedback ?? "",
						...next,
					},
				],
			};
		});
	}
	return (
		<fieldset
			aria-labelledby={`${prefix}-scorecard`}
			disabled={disabled}
			className="@container/scorecard min-w-0 rounded-xl border bg-card"
		>
			<div className="flex flex-wrap items-center justify-between gap-2 px-4 py-3.5 sm:px-5">
				<h3 id={`${prefix}-scorecard`} className="font-semibold">
					Scorecard
				</h3>
				<p className="rounded-md bg-muted px-2.5 py-1 text-xs font-medium text-muted-foreground tabular-nums">
					{rated} of {criteria.skills.length} rated
				</p>
			</div>
			<div className="divide-y border-y">
				{criteria.skills.map(({ id, name }) => (
					<SkillRating
						key={id}
						name={name}
						response={ratings.get(id)}
						onChange={(change) => changeRating(id, change)}
					/>
				))}
			</div>
			<div className="space-y-4 px-4 py-4 sm:px-5">
				<Field className="max-w-64 gap-2">
					<FieldLabel htmlFor={`${prefix}-decision`}>Decision</FieldLabel>
					<select
						id={`${prefix}-decision`}
						className={selectClass}
						value={content.decision ?? ""}
						onChange={(event) => {
							const decision =
								assessmentDecisionSchema.safeParse(event.target.value).data ??
								null;
							onChange((current) => ({ ...current, decision }));
						}}
					>
						<option value="">Choose a decision</option>
						{assessmentDecisionsByRound[level].map((decision) => (
							<option key={decision} value={decision}>
								{decisionLabels[decision]}
							</option>
						))}
					</select>
				</Field>
				<Field className="gap-2">
					<FieldLabel htmlFor={`${prefix}-rationale`}>
						Decision rationale
					</FieldLabel>
					<Textarea
						id={`${prefix}-rationale`}
						className="field-sizing-fixed resize-y"
						rows={3}
						maxLength={4_000}
						value={content.rationale}
						onChange={(event) => {
							const rationale = limitText(event.target.value, 2_000);
							onChange((current) => ({ ...current, rationale }));
						}}
					/>
				</Field>
			</div>
		</fieldset>
	);
}
