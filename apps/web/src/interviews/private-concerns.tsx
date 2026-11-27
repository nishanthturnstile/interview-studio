import {
	concernEntrySchema,
	concernViewSchema,
	type SaveConcern,
	saveConcernSchema,
} from "@studio/contracts";
import { useQuery } from "@tanstack/react-query";
import { LockKeyhole } from "lucide-react";
import { type FormEvent, useId, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
	Field,
	FieldError,
	FieldGroup,
	FieldLabel,
} from "@/components/ui/field";
import { Textarea } from "@/components/ui/textarea";
import { accessDenied, interviewRequest, retryInterviewRead } from "./api";
import { isTransientWorkspaceError } from "./artifact-queue";
import { InterviewAlert } from "./display";

export function PrivateConcerns({
	roundId,
	staffId,
	active,
	suspended,
}: {
	roundId: string;
	staffId: string;
	active: boolean;
	suspended: boolean;
}) {
	const id = useId();
	const path = `/staff/my-interviews/${roundId}/concerns`;
	const [observation, setObservation] = useState("");
	const [context, setContext] = useState("");
	const [busy, setBusy] = useState(false);
	const [notice, setNotice] = useState("");
	const [error, setError] = useState<unknown>();
	const [invalid, setInvalid] = useState<string>();
	const pending = useRef<SaveConcern>(null);
	const request = useQuery({
		queryKey: ["private-interview-concerns", staffId, roundId, active],
		queryFn: ({ signal }) =>
			interviewRequest(path, concernViewSchema, { signal }),
		refetchOnWindowFocus: "always",
		refetchInterval: ({ state }) =>
			accessDenied(state.error) ? false : 15_000,
		retry: retryInterviewRead,
		gcTime: 0,
	});
	const view = accessDenied(request.error) ? undefined : request.data;

	async function submit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		if (busy || !view?.canAdd) return;
		const previous = pending.current;
		const parsed = saveConcernSchema.safeParse({
			observation,
			context,
			commandId: previous?.commandId ?? crypto.randomUUID(),
		});
		if (!parsed.success) {
			setInvalid(String(parsed.error.issues[0]?.path[0] ?? ""));
			return;
		}
		const data = parsed.data;
		if (
			previous &&
			(previous.observation !== data.observation ||
				previous.context !== data.context)
		)
			data.commandId = crypto.randomUUID();
		pending.current = data;
		setBusy(true);
		setInvalid(undefined);
		setNotice("");
		setError(undefined);
		let saved = false;
		try {
			await interviewRequest(path, concernEntrySchema, { data });
			saved = true;
		} catch (error) {
			if (isTransientWorkspaceError(error)) {
				const readback = await request.refetch();
				saved = !!readback.data?.entries.some(
					(entry) => entry.commandId === data.commandId,
				);
			}
			if (!saved) setError(error);
		} finally {
			if (saved) {
				pending.current = null;
				setContext("");
				setObservation("");
				setNotice("Observation saved.");
				void request.refetch();
			}
			setBusy(false);
		}
	}

	return (
		<details
			data-workspace-content
			hidden={suspended}
			className="rounded-xl border bg-card"
		>
			<summary className="cursor-pointer px-4 py-3 text-sm font-semibold focus-visible:outline-2 focus-visible:outline-ring">
				<LockKeyhole
					className="mr-2 inline size-4 text-muted-foreground"
					aria-hidden="true"
				/>
				Private observations
				{view?.entries.length ? ` (${view.entries.length})` : ""}
			</summary>
			<div className="flex flex-col gap-4 border-t p-4">
				<p className="text-sm text-muted-foreground">
					Only you can see these observations on the assigned round.
				</p>
				{request.isPending && (
					<p role="status" className="text-sm text-muted-foreground">
						Loading observations…
					</p>
				)}
				{request.error && !view && (
					<>
						<InterviewAlert error={request.error} />
						{!accessDenied(request.error) && (
							<Button
								className="self-start"
								size="sm"
								variant="outline"
								onClick={() => void request.refetch()}
							>
								Retry observations
							</Button>
						)}
					</>
				)}
				{active && view?.canAdd && (
					<form
						className="flex flex-col gap-3"
						onSubmit={(event) => void submit(event)}
						noValidate
					>
						<FieldGroup className="gap-3">
							<Field data-invalid={invalid === "context"}>
								<FieldLabel htmlFor={`${id}-context`}>Context</FieldLabel>
								<Textarea
									id={`${id}-context`}
									value={context}
									onChange={(event) => {
										setContext(event.target.value);
										setInvalid(undefined);
									}}
									placeholder="Question or activity being discussed"
									rows={2}
									disabled={busy}
									maxLength={2_000}
									aria-invalid={invalid === "context"}
									aria-describedby={
										invalid === "context" ? `${id}-context-error` : undefined
									}
									required
								/>
								{invalid === "context" && (
									<FieldError id={`${id}-context-error`}>
										Enter 1–1,000 characters of context.
									</FieldError>
								)}
							</Field>
							<Field data-invalid={invalid === "observation"}>
								<FieldLabel htmlFor={`${id}-observation`}>
									Observation
								</FieldLabel>
								<Textarea
									id={`${id}-observation`}
									value={observation}
									onChange={(event) => {
										setObservation(event.target.value);
										setInvalid(undefined);
									}}
									rows={3}
									disabled={busy}
									maxLength={2_000}
									aria-invalid={invalid === "observation"}
									aria-describedby={
										invalid === "observation"
											? `${id}-observation-error`
											: undefined
									}
									required
								/>
								{invalid === "observation" && (
									<FieldError id={`${id}-observation-error`}>
										Enter 1–1,000 characters for this observation.
									</FieldError>
								)}
							</Field>
						</FieldGroup>
						{error !== undefined && <InterviewAlert error={error} />}
						<Button
							className="self-start"
							type="submit"
							disabled={busy}
							size="sm"
						>
							{busy ? "Saving observation…" : "Save observation"}
						</Button>
					</form>
				)}
				{active && view && !view.canAdd && view.entries.length === 50 && (
					<p className="text-sm text-muted-foreground">
						This round has reached its 50-observation limit.
					</p>
				)}
				{notice && (
					<p role="status" className="text-sm">
						{notice}
					</p>
				)}
				{view?.entries.length ? (
					<ol className="flex flex-col divide-y rounded-md border">
						{view.entries.map((entry) => (
							<li key={entry.id} className="flex flex-col gap-1 p-3 text-sm">
								<p className="font-medium whitespace-pre-wrap wrap-anywhere">
									{entry.context}
								</p>
								<p className="whitespace-pre-wrap wrap-anywhere">
									{entry.observation}
								</p>
								<time
									className="text-xs text-muted-foreground"
									dateTime={entry.createdAt}
								>
									{new Date(entry.createdAt).toLocaleString()}
								</time>
							</li>
						))}
					</ol>
				) : view && !active ? (
					<p className="text-sm text-muted-foreground">
						No observations were saved.
					</p>
				) : null}
			</div>
		</details>
	);
}
