import {
	type Candidate,
	candidatePatchSchema,
	candidateSchema,
} from "@studio/contracts";
import { type FormEvent, useEffect, useId, useState } from "react";
import { Alert, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
	type DriveRequest,
	DriveRequestError,
	jsonRequest,
	requestMessage,
} from "./api";

export const reviewLabel = {
	draft: "Draft",
	confirmed: "Confirmed",
	duplicate: "Duplicate",
};

function fields(candidate: Candidate) {
	return {
		name: candidate.name,
		email: candidate.email ?? "",
		years: candidate.years?.toString() ?? "",
	};
}

export function CandidateEditor({
	driveId,
	candidate,
	request,
	onSaved,
	onDirty,
	onPending,
}: {
	driveId: string;
	candidate: Candidate;
	request: DriveRequest;
	onSaved: (row: Candidate) => void;
	onDirty: (key: string, dirty: boolean) => void;
	onPending: (pending: boolean) => void;
}) {
	const id = useId();
	const [draft, setDraft] = useState<ReturnType<typeof fields>>();
	const [revision, setRevision] = useState<number>();
	const [pending, setPending] = useState(false);
	const [notice, setNotice] = useState("");
	const [problem, setProblem] = useState<{
		message: string;
		field?: string;
		current?: Candidate;
		target?: { id: string; revision: number };
	}>();
	const values = draft ?? fields(candidate);
	const dirty = Boolean(draft);
	const hasSavedIdentity = Boolean(candidate.name.trim() && candidate.email);
	useEffect(() => {
		onDirty(candidate.id, dirty);
		return () => onDirty(candidate.id, false);
	}, [candidate.id, dirty, onDirty]);

	function edit(next: ReturnType<typeof fields>) {
		const saved = fields(candidate);
		const changed =
			next.name !== saved.name ||
			next.email !== saved.email ||
			next.years !== saved.years;
		setDraft(changed ? next : undefined);
		setRevision(changed ? (revision ?? candidate.revision) : undefined);
		setProblem(undefined);
		setNotice("");
	}

	async function submit(action: "save" | "confirm" | "duplicate") {
		const path = `/${driveId}/candidates/${candidate.id}`;
		const currentRevision = revision ?? candidate.revision;
		let payload: object = { revision: currentRevision };
		if (action === "save") {
			const input = candidatePatchSchema.safeParse({
				name: values.name,
				email: values.email,
				years: values.years === "" ? null : Number(values.years),
				revision: currentRevision,
			});
			if (!input.success) {
				const field = String(input.error.issues[0]?.path[0]);
				setProblem({
					field,
					message:
						field === "years"
							? "Enter 0 to 80 years with up to one decimal place."
							: field === "email"
								? "Enter a valid email address or clear the field."
								: "Check the candidate name.",
				});
				return;
			}
			payload = input.data;
		}
		if (action === "duplicate") {
			if (!problem?.target) return;
			payload = {
				...payload,
				targetId: problem.target.id,
				targetRevision: problem.target.revision,
			};
		}
		setProblem(undefined);
		setNotice("");
		setPending(true);
		onPending(true);
		try {
			const updated = await request(
				action === "save" ? path : `${path}/${action}`,
				candidateSchema,
				jsonRequest(action === "save" ? "PATCH" : "POST", payload),
			);
			onSaved(updated);
			setDraft(undefined);
			setRevision(undefined);
			setNotice(
				action === "save"
					? "Candidate saved."
					: action === "confirm"
						? "Candidate confirmed."
						: "Recorded as a duplicate.",
			);
		} catch (error) {
			const data =
				error instanceof DriveRequestError ? error.problem : undefined;
			const current = candidateSchema.safeParse(data?.current);
			const message =
				data?.error === "invalid_input" && action === "confirm"
					? "Save a name and valid email before confirming."
					: requestMessage(error);
			setProblem({
				message,
				field: data?.field,
				current: current.success ? current.data : undefined,
				target: data?.target,
			});
		} finally {
			setPending(false);
			onPending(false);
		}
	}

	const suggestions = candidate.suggestions;
	const hasSuggestions = suggestions && Object.keys(suggestions).length > 0;
	return (
		<div className="flex flex-col gap-3">
			{candidate.reviewState === "duplicate" ? (
				<p className="flex flex-wrap items-center gap-2 text-sm [overflow-wrap:anywhere]">
					<Badge variant="secondary">Duplicate</Badge> {candidate.name}{" "}
					{candidate.email}
				</p>
			) : (
				<form
					className="flex flex-col gap-3"
					noValidate
					onSubmit={(event: FormEvent) => {
						event.preventDefault();
						void submit("save");
					}}
				>
					{hasSuggestions && (
						<section
							aria-labelledby={`${id}-suggestions`}
							className="rounded-lg border bg-muted/35 p-3.5 sm:p-4"
						>
							<h3 id={`${id}-suggestions`} className="font-semibold">
								Extraction suggestions
							</h3>
							<dl className="mt-2 grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-sm [overflow-wrap:anywhere]">
								{suggestions.name && (
									<>
										<dt className="text-muted-foreground">Name</dt>
										<dd>{suggestions.name}</dd>
									</>
								)}
								{suggestions.email && (
									<>
										<dt className="text-muted-foreground">Email</dt>
										<dd>{suggestions.email}</dd>
									</>
								)}
								{suggestions.years != null && (
									<>
										<dt className="text-muted-foreground">Experience</dt>
										<dd>{suggestions.years} years</dd>
									</>
								)}
							</dl>
							<Button
								className="mt-2.5"
								size="sm"
								type="button"
								variant="outline"
								disabled={
									pending ||
									!(
										(!values.name && suggestions.name) ||
										(!values.email && suggestions.email) ||
										(!values.years && suggestions.years != null)
									)
								}
								onClick={() =>
									edit({
										name: values.name || suggestions.name || "",
										email: values.email || suggestions.email || "",
										years: values.years || suggestions.years?.toString() || "",
									})
								}
							>
								Fill empty fields from suggestions
							</Button>
						</section>
					)}
					<div className="flex flex-wrap items-center justify-between gap-2 pt-2">
						<h3 className="text-base font-semibold">Candidate record</h3>
						<Badge
							variant={
								dirty
									? "warning"
									: candidate.reviewState === "confirmed"
										? "success"
										: "secondary"
							}
						>
							{dirty ? "Unsaved changes" : reviewLabel[candidate.reviewState]}
						</Badge>
					</div>
					<FieldGroup className="grid gap-3 sm:grid-cols-2">
						<Field
							className="sm:col-span-2"
							data-invalid={problem?.field === "name" || undefined}
						>
							<FieldLabel htmlFor={`${id}-name`}>Candidate name</FieldLabel>
							<Input
								id={`${id}-name`}
								aria-invalid={problem?.field === "name"}
								autoComplete="off"
								maxLength={120}
								disabled={pending}
								value={values.name}
								onChange={(event) =>
									edit({ ...values, name: event.target.value })
								}
							/>
						</Field>
						<Field data-invalid={problem?.field === "email" || undefined}>
							<FieldLabel htmlFor={`${id}-email`}>Candidate email</FieldLabel>
							<Input
								id={`${id}-email`}
								aria-invalid={problem?.field === "email"}
								type="email"
								autoComplete="off"
								maxLength={254}
								disabled={pending}
								value={values.email}
								onChange={(event) =>
									edit({ ...values, email: event.target.value })
								}
							/>
						</Field>
						<Field data-invalid={problem?.field === "years" || undefined}>
							<FieldLabel htmlFor={`${id}-years`}>
								Years of experience
							</FieldLabel>
							<Input
								id={`${id}-years`}
								aria-invalid={problem?.field === "years"}
								type="number"
								min="0"
								max="80"
								step="0.1"
								disabled={pending}
								value={values.years}
								onChange={(event) =>
									edit({ ...values, years: event.target.value })
								}
							/>
						</Field>
					</FieldGroup>

					<div className="flex flex-wrap gap-2">
						<Button type="submit" size="sm" disabled={pending || !dirty}>
							{candidate.reviewState === "draft"
								? "Save draft"
								: "Save candidate"}
						</Button>
						{candidate.reviewState === "draft" && (
							<Button
								type="button"
								size="sm"
								variant="outline"
								disabled={pending || dirty || !hasSavedIdentity}
								onClick={() => void submit("confirm")}
							>
								Confirm candidate
							</Button>
						)}
					</div>
					{candidate.reviewState === "draft" && !hasSavedIdentity && (
						<p className="text-xs text-muted-foreground">
							Save a name and email to confirm this candidate.
						</p>
					)}
				</form>
			)}
			{problem && (
				<Alert variant="destructive">
					<AlertTitle>{problem.message}</AlertTitle>
				</Alert>
			)}
			{problem?.current && (
				<Button
					size="sm"
					variant="outline"
					className="self-start"
					onClick={() => {
						if (!problem.current) return;
						onSaved(problem.current);
						setRevision(draft ? problem.current.revision : undefined);
						setProblem(
							problem.target
								? {
										...problem,
										current: undefined,
										message:
											"Review the current candidate before linking the duplicate.",
									}
								: undefined,
						);
					}}
				>
					Use latest candidate revision
				</Button>
			)}
			{problem?.target &&
				!problem.current &&
				!dirty &&
				candidate.reviewState === "draft" && (
					<Button
						size="sm"
						variant="outline"
						className="self-start"
						disabled={pending}
						onClick={() => void submit("duplicate")}
					>
						Link to confirmed candidate as duplicate
					</Button>
				)}
			{notice && (
				<p role="status" className="text-sm">
					{notice}
				</p>
			)}
			{candidate.extractedText && (
				<details className="mt-1 border-t pt-3 text-sm">
					<summary className="cursor-pointer rounded-sm font-medium focus-visible:outline-2 focus-visible:outline-ring">
						Extracted text
					</summary>
					<div className="mt-2 max-h-52 overflow-y-auto rounded-md bg-muted p-3 whitespace-pre-wrap [overflow-wrap:anywhere]">
						{candidate.extractedText}
					</div>
				</details>
			)}
		</div>
	);
}
