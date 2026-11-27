import {
	type CodeRunOutput,
	type CodeRunRequest,
	type CodeRunSummary,
	codeInputLimit,
	codeLanguages,
	codeRunPending,
	codeRunRequestSchema,
} from "@studio/contracts";
import { Play } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { InterviewRequestError } from "./api";
import { InterviewAlert } from "./display";
import type { WorkspaceClient } from "./workspace-client";

export type WorkspaceExecution = {
	client: WorkspaceClient;
	enabled: boolean;
	latest?: CodeRunSummary;
};
type Program = Pick<CodeRunRequest, "language" | "source">;

const messages = {
	queued: "Queued",
	running: "Running",
	succeeded: "Completed",
	compile_error: "Compilation failed",
	runtime_error: "Program failed",
	timed_out: "Time limit exceeded",
	limit_exceeded: "Resource limit exceeded",
	interrupted: "Run interrupted",
} satisfies Record<CodeRunSummary["state"], string>;

export function WorkspaceCodeRun({
	execution,
	program,
	readOnly,
	children,
}: {
	execution?: WorkspaceExecution;
	program: Program;
	readOnly: boolean;
	children: (slots: {
		actions?: ReactNode;
		input?: ReactNode;
		output?: ReactNode;
	}) => ReactNode;
}) {
	const [input, setInput] = useState("");
	const [submitting, setSubmitting] = useState(false);
	const [error, setError] = useState<unknown>();
	const [retry, setRetry] = useState<CodeRunRequest>();
	const consoleRegion = useRef<HTMLElement>(null);
	const latest = execution?.latest;
	const enabled = !readOnly && execution?.enabled === true;
	const busy = submitting || codeRunPending(latest?.state);

	async function submit(command: CodeRunRequest) {
		if (busy || !enabled || !execution) return;
		consoleRegion.current?.scrollIntoView({ block: "nearest" });
		const parsed = codeRunRequestSchema.safeParse(command);
		if (!parsed.success) {
			setError(
				new InterviewRequestError(422, {
					error: "workspace_invalid",
					kind: "code",
					field: parsed.error.issues[0]?.path.join("."),
				}),
			);
			return;
		}
		setSubmitting(true);
		setError(undefined);
		setRetry(undefined);
		try {
			await execution.client.runCode(parsed.data);
		} catch (error) {
			setError(error);
			if (!(error instanceof InterviewRequestError) || error.status >= 500)
				setRetry(parsed.data);
		} finally {
			setSubmitting(false);
		}
	}

	return children({
		actions: enabled ? (
			<Button
				size="sm"
				disabled={busy || Boolean(retry)}
				onClick={() =>
					void submit({
						commandId: crypto.randomUUID(),
						language: program.language,
						source: program.source,
						input,
					})
				}
			>
				<Play aria-hidden="true" />
				{submitting
					? "Submitting…"
					: latest && codeRunPending(latest.state)
						? messages[latest.state]
						: "Run"}
			</Button>
		) : undefined,
		input: enabled ? (
			<details className="border-b px-3 py-2">
				<summary className="w-fit cursor-pointer text-sm text-muted-foreground">
					Program input{input ? " · added" : ""}
				</summary>
				<label className="mt-2 grid gap-1 text-sm">
					<span className="sr-only">Program input</span>
					<textarea
						rows={3}
						maxLength={codeInputLimit}
						value={input}
						onChange={(event) => setInput(event.target.value)}
						className="w-full resize-y rounded-md border bg-background p-2 font-mono"
					/>
				</label>
			</details>
		) : undefined,
		output: (enabled || latest || error !== undefined) && (
			<section
				ref={consoleRegion}
				aria-label="Console"
				className="grid shrink-0 gap-2 border-t px-3 py-2"
			>
				<h3 className="text-sm font-medium">Console</h3>
				{!latest && error === undefined && (
					<p role="status" className="text-xs text-muted-foreground">
						{submitting ? "Submitting…" : "Run your code to see output here."}
					</p>
				)}
				{error !== undefined && (
					<div className="grid justify-items-start gap-2">
						<InterviewAlert error={error} />
						{retry && (
							<div className="flex flex-wrap gap-2">
								<Button
									variant="outline"
									size="sm"
									disabled={busy || !enabled}
									onClick={() => void submit(retry)}
								>
									Retry previous submission
								</Button>
								<Button
									variant="ghost"
									size="sm"
									onClick={() => {
										setRetry(undefined);
										setError(undefined);
									}}
								>
									Dismiss
								</Button>
							</div>
						)}
					</div>
				)}
				{latest && execution && (
					<RunOutput
						key={latest.id}
						client={execution.client}
						run={latest}
						program={program}
						input={readOnly ? undefined : input}
					/>
				)}
			</section>
		),
	});
}

function RunOutput({
	client,
	run,
	program,
	input,
}: {
	client: WorkspaceClient;
	run: CodeRunSummary;
	program: Program;
	input?: string;
}) {
	const [output, setOutput] = useState<CodeRunOutput>();
	const [loadError, setLoadError] = useState<unknown>();
	const [attempt, setAttempt] = useState(0);
	const [digests, setDigests] = useState<{ source: string; input?: string }>();
	const pending = codeRunPending(run.state);
	// biome-ignore lint/correctness/useExhaustiveDependencies: Retry also reloads the same run.
	useEffect(() => {
		if (pending) return;
		const request = new AbortController();
		void client
			.readRun(run.id, request.signal)
			.then(setOutput)
			.catch((error) => {
				if (!request.signal.aborted) setLoadError(error);
			});
		return () => request.abort();
	}, [client, run.id, pending, attempt]);
	useEffect(() => {
		let current = true;
		const timer = setTimeout(() => {
			if (!crypto.subtle) return;
			void Promise.all([
				digestText(program.source),
				input === undefined ? undefined : digestText(input),
			])
				.then(([source, input]) => {
					if (current) setDigests({ source, input });
				})
				.catch(() => {});
		}, 150);
		return () => {
			current = false;
			clearTimeout(timer);
		};
	}, [program.source, input]);
	const stale =
		program.language !== run.language ||
		(digests && digests.source !== run.digest);
	const staleInput =
		digests?.input !== undefined && digests.input !== run.inputDigest;
	return (
		<div className="grid gap-2">
			<div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
				<p role="status" className="text-xs text-muted-foreground">
					{codeLanguages[run.language].label} · {messages[run.state]}
				</p>
				{stale && (
					<span className="text-xs text-muted-foreground">
						From earlier code
					</span>
				)}
				{staleInput && (
					<span className="text-xs text-muted-foreground">
						From earlier input
					</span>
				)}
			</div>
			{loadError !== undefined && (
				<Button
					variant="outline"
					size="sm"
					className="w-fit"
					onClick={() => {
						setLoadError(undefined);
						setAttempt(attempt + 1);
					}}
				>
					Retry loading output
				</Button>
			)}
			{output &&
				!output.stdout &&
				!output.stderr &&
				run.state !== "interrupted" && (
					<p className="text-sm text-muted-foreground">No output.</p>
				)}
			{output?.stdout && (
				<pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all rounded-md bg-background p-2 text-xs">
					{output.stdout}
				</pre>
			)}
			{output?.stderr && (
				<div className="grid gap-1">
					<p className="text-xs font-medium text-destructive">Errors</p>
					<pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all rounded-md bg-background p-2 text-xs text-destructive">
						{output.stderr}
					</pre>
				</div>
			)}
		</div>
	);
}

async function digestText(text: string) {
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(text),
	);
	return Array.from(new Uint8Array(digest), (byte) =>
		byte.toString(16).padStart(2, "0"),
	).join("");
}
