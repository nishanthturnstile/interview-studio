import {
	type DriveIntake,
	type JobDescription,
	jobDescriptionLimit,
	jobDescriptionSchema,
} from "@studio/contracts";
import { FileText, RotateCcw } from "lucide-react";
import {
	type FormEvent,
	type ReactNode,
	useCallback,
	useEffect,
	useId,
	useState,
} from "react";
import { Alert, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldLabel } from "@/components/ui/field";
import { Textarea } from "@/components/ui/textarea";
import {
	type DriveRequest,
	DriveRequestError,
	jsonRequest,
	requestMessage,
} from "./api";

export function JobDescriptionEditor({
	driveId,
	refreshKey,
	request,
	source,
	onSaved,
	onDirty,
}: {
	driveId: string;
	refreshKey: string | undefined;
	request: DriveRequest;
	source: ReactNode;
	onSaved: (intake: DriveIntake) => void;
	onDirty: (key: string, value: boolean) => void;
}) {
	const path = `/${driveId}/job-description`;
	const id = useId();
	const [saved, setSaved] = useState<JobDescription>();
	const [draft, setDraft] = useState<{ text: string; revision: number }>();
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState("");
	const [loadError, setLoadError] = useState("");
	const [conflict, setConflict] = useState<JobDescription>();

	const load = useCallback(
		async (signal?: AbortSignal) => {
			setLoadError("");
			try {
				const current = await request(path, jobDescriptionSchema, { signal });
				setSaved((previous) =>
					previous && previous.jdRevision > current.jdRevision
						? previous
						: current,
				);
			} catch (error) {
				if (!signal?.aborted) setLoadError(requestMessage(error));
			}
		},
		[path, request],
	);

	useEffect(() => {
		if (!refreshKey) return;
		const controller = new AbortController();
		void load(controller.signal);
		return () => controller.abort();
	}, [load, refreshKey]);

	const dirty = Boolean(draft);
	useEffect(() => {
		onDirty("job-description", dirty);
		return () => onDirty("job-description", false);
	}, [dirty, onDirty]);

	const text = draft?.text ?? saved?.editedText ?? saved?.extractedText ?? "";
	const extracted = saved?.extractedText;
	function edit(text: string) {
		if (!saved) return;
		const original = saved.editedText ?? saved.extractedText ?? "";
		setDraft(
			text === original
				? undefined
				: { text, revision: draft?.revision ?? saved.jdRevision },
		);
		setError("");
	}

	async function submit(event: FormEvent) {
		event.preventDefault();
		if (!draft || saving || conflict) return;
		setSaving(true);
		setError("");
		try {
			const updated = await request(
				path,
				jobDescriptionSchema,
				jsonRequest("PUT", draft),
			);
			setSaved(updated);
			setDraft(undefined);
			onSaved(updated);
		} catch (error) {
			setError(requestMessage(error));
			if (
				error instanceof DriveRequestError &&
				error.problem.error === "revision_conflict"
			) {
				const current = jobDescriptionSchema.safeParse(error.problem.current);
				if (current.success) setConflict(current.data);
			}
		} finally {
			setSaving(false);
		}
	}

	return (
		<Card id="job-description" size="sm" className="min-w-0 scroll-mt-6 gap-3">
			<CardHeader>
				<CardTitle>
					<h2 className="flex items-center gap-2">
						<FileText
							aria-hidden="true"
							className="size-4 shrink-0 text-muted-foreground"
						/>
						Job description
					</h2>
				</CardTitle>
			</CardHeader>
			<CardContent className="flex flex-col gap-4">
				<form className="flex min-w-0 flex-col gap-3" onSubmit={submit}>
					<Field>
						<FieldLabel htmlFor={id} className="sr-only">
							Job description text
						</FieldLabel>
						<Textarea
							id={id}
							className="h-36 min-h-28 max-h-96 min-w-0 resize-y overflow-auto [field-sizing:fixed] px-3 py-2.5 leading-relaxed caret-primary"
							value={text}
							placeholder="Type or paste the responsibilities, requirements, and qualifications…"
							maxLength={jobDescriptionLimit}
							disabled={!saved || saving}
							onChange={(event) => edit(event.target.value)}
						/>
					</Field>
					<div className="flex min-h-10 flex-wrap items-center justify-between gap-x-3 gap-y-1">
						<p role="status" className="text-xs text-muted-foreground">
							{dirty
								? "Unsaved changes"
								: saved?.editedText != null
									? "Saved"
									: extracted
										? "Text from imported file"
										: !saved && !loadError
											? "Loading description…"
											: ""}
						</p>
						<Button
							type="submit"
							size="sm"
							disabled={!draft || saving || Boolean(conflict)}
						>
							{saving ? "Saving…" : "Save description"}
						</Button>
					</div>
					{loadError && (
						<Alert variant="destructive">
							<AlertTitle>{loadError}</AlertTitle>
							<Button
								type="button"
								size="sm"
								variant="outline"
								onClick={() => void load()}
							>
								Reload description
							</Button>
						</Alert>
					)}
					{error && (
						<Alert variant="destructive">
							<AlertTitle>{error}</AlertTitle>
						</Alert>
					)}
					{conflict && (
						<div className="flex flex-wrap gap-2">
							<Button
								type="button"
								size="sm"
								variant="outline"
								onClick={() => {
									setSaved(conflict);
									setConflict(undefined);
									setError("");
									setDraft(undefined);
									onSaved(conflict);
								}}
							>
								Load saved version
							</Button>
							<Button
								type="button"
								size="sm"
								variant="outline"
								onClick={() => {
									setSaved(conflict);
									setDraft(
										(value) =>
											value && { ...value, revision: conflict.jdRevision },
									);
									setConflict(undefined);
									setError("");
									onSaved(conflict);
								}}
							>
								Keep my edits
							</Button>
						</div>
					)}
				</form>
				<div className="flex min-w-0 flex-col gap-3 border-t pt-3">
					{source}
					{extracted && extracted !== text && (
						<Button
							className="self-start"
							size="sm"
							variant="ghost"
							disabled={saving || Boolean(conflict)}
							onClick={() => edit(extracted)}
						>
							<RotateCcw aria-hidden="true" />
							Use text from file
						</Button>
					)}
				</div>
			</CardContent>
		</Card>
	);
}
