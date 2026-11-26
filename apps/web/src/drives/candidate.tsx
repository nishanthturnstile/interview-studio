import {
	type Candidate,
	candidatePatchSchema,
	candidateSchema,
} from "@studio/contracts";
import { ChevronDown, ClipboardCheck } from "lucide-react";
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
import { Button } from "@/components/ui/button";
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
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

function ReviewDisclosure({
	label,
	children,
}: {
	label: string;
	children: ReactNode;
}) {
	return (
		<Collapsible>
			<CollapsibleTrigger
				render={
					<Button
						size="sm"
						variant="ghost"
						className="group w-full justify-between px-2.5"
					/>
				}
			>
				{label}
				<ChevronDown
					aria-hidden="true"
					className="text-muted-foreground group-aria-expanded:rotate-180"
				/>
			</CollapsibleTrigger>
			<CollapsibleContent className="px-2.5 pt-1 pb-3">
				{children}
			</CollapsibleContent>
		</Collapsible>
	);
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
	const nameInput = useRef<HTMLInputElement>(null);
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
	const canFill =
		suggestions &&
		((!values.name && suggestions.name) ||
			(!values.email && suggestions.email) ||
			(!values.years && suggestions.years != null));
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
					<div className="flex flex-wrap items-center justify-between gap-2">
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
					<FieldGroup className="grid gap-3 @min-[23rem]/candidate:grid-cols-[minmax(0,1fr)_9rem]">
						<Field
							className="@min-[23rem]/candidate:col-span-2"
							data-invalid={problem?.field === "name" || undefined}
						>
							<FieldLabel htmlFor={`${id}-name`}>Candidate name</FieldLabel>
							<Input
								ref={nameInput}
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

					{canFill && (
						<Button
							type="button"
							size="sm"
							variant="secondary"
							className="self-start"
							disabled={pending}
							onClick={() => {
								edit({
									name: values.name || suggestions.name || "",
									email: values.email || suggestions.email || "",
									years: values.years || suggestions.years?.toString() || "",
								});
								nameInput.current?.focus({ preventScroll: true });
							}}
						>
							<ClipboardCheck data-icon="inline-start" aria-hidden="true" />
							Fill empty fields from suggestions
						</Button>
					)}

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
			{(hasSuggestions || candidate.extractedText) && (
				<div>
					<Separator className="mb-1" />
					{hasSuggestions && (
						<ReviewDisclosure label="Extraction suggestions">
							<dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-sm [overflow-wrap:anywhere]">
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
						</ReviewDisclosure>
					)}
					{candidate.extractedText && (
						<ReviewDisclosure label="Extracted text">
							<div className="max-h-60 overflow-y-auto overscroll-contain rounded-lg bg-muted p-3 text-sm whitespace-pre-wrap [overflow-wrap:anywhere]">
								{candidate.extractedText}
							</div>
						</ReviewDisclosure>
					)}
				</div>
			)}
		</div>
	);
}
