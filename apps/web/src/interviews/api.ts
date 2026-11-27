import { type InterviewError, interviewErrorSchema } from "@studio/contracts";
import { useEffect, useRef, useState } from "react";
import type { z } from "zod";

export class InterviewRequestError extends Error {
	readonly problem: InterviewError | undefined;
	readonly status: number;
	constructor(status: number, problem: InterviewError | undefined) {
		super(problem?.error ?? "request_failed");
		this.status = status;
		this.problem = problem;
	}
}

export function accessDenied(error: unknown) {
	return (
		error instanceof InterviewRequestError &&
		[401, 403, 404].includes(error.status)
	);
}

export function retryInterviewRead(failures: number, error: Error) {
	return (
		failures < 1 &&
		(!(error instanceof InterviewRequestError) || error.status >= 500)
	);
}

export async function interviewRequest<T extends z.ZodType>(
	path: string,
	schema: T,
	options: {
		signal?: AbortSignal;
		data?: unknown;
		method?: "POST" | "PATCH";
		cached?: z.output<T> & { revisionTag?: string };
	} = {},
): Promise<z.output<T>> {
	const response = await fetch(`/api${path}`, {
		method: options.method ?? (options.data !== undefined ? "POST" : "GET"),
		cache: "no-store",
		signal: options.signal
			? AbortSignal.any([options.signal, AbortSignal.timeout(20_000)])
			: AbortSignal.timeout(20_000),
		...(options.data !== undefined
			? {
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify(options.data),
				}
			: options.cached?.revisionTag
				? { headers: { "If-None-Match": options.cached.revisionTag } }
				: {}),
	});
	if (response.status === 304 && options.cached?.revisionTag)
		return options.cached;
	const json = await response.json().catch(() => null);
	if (!response.ok)
		throw new InterviewRequestError(
			response.status,
			interviewErrorSchema.safeParse(json).data,
		);
	return schema.parse(json);
}

const messages: Partial<Record<InterviewError["error"], string>> = {
	invalid_input: "Check the form details and try again.",
	invalid_time_zone: "Enter a valid IANA time zone, such as Asia/Kolkata.",
	invalid_slot: "Enter a valid interview date and time.",
	nonexistent_time:
		"That local time is skipped by the daylight-saving change. Choose another time.",
	ambiguous_time:
		"That local time occurs twice. Choose the intended UTC offset.",
	round_not_eligible:
		"This candidate is no longer eligible for this round. Refresh the queue.",
	panelist_ineligible:
		"This panelist is no longer eligible. Choose another verified panelist.",
	slot_conflict:
		"This slot overlaps another interview. Review the conflicts before continuing.",
	preferences_changed:
		"Your scheduling settings changed. Review the current time zone and duration before saving.",
	skills_need_review:
		"HR needs to review the drive’s scorecard skills for this round.",
	skills_changed:
		"The reviewed skills changed. Check the current criteria before booking.",
	workflow_changed:
		"The candidate’s interview progress changed. Review the latest details before trying again.",
	draft_changed:
		"A newer draft was saved. Compare it with your changes before saving again.",
	assessment_incomplete:
		"Rate every skill, choose a decision, and enter a rationale before submitting.",
	l1_handoff_changed:
		"Review and acknowledge the current L1 scorecard before submitting.",
	pending_feedback_review:
		"HR must resolve the pending feedback review before this action is available.",
	feedback_version_changed:
		"A newer version was submitted. Review it before saving your correction.",
	feedback_review_changed:
		"The review changed. Check the latest L1 decision before resolving it.",
	revision_conflict:
		"This record changed. Review the latest details before trying again.",
	idempotency_conflict:
		"That action was already used for other changes. Review the current details.",
	invalid_transition: "This action is no longer available for the round.",
	candidate_not_present:
		"The candidate is not connected. Wait for them to rejoin.",
	entry_closed:
		"The scheduled entry window has closed. Contact your interview coordinator.",
	invite_unavailable:
		"This invitation is unavailable. Check the email address or reopen the link from your invitation.",
	invalid_code:
		"The code is invalid or expired. Check the code or request a new one.",
	delivery_failed: "The email could not be sent. Try sending the code again.",
	rate_limited: "Please wait before trying again.",
	unavailable: "This interview has ended or is unavailable.",
	not_found: "This interview is unavailable.",
	unauthenticated: "Sign in again to continue.",
	forbidden: "Your staff role does not have access to this page.",
};

export function interviewMessage(error: unknown) {
	if (error instanceof InterviewRequestError) {
		if (error.status === 413)
			return "The assessment is too large. Shorten your notes or feedback and try again.";
		const problem = error.problem;
		if (problem?.error === "too_early" && problem.opensAt) {
			return `You can join from ${new Date(problem.opensAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })} in your local time.`;
		}
		if (problem?.retryAfter)
			return `Try again in ${problem.retryAfter} seconds.`;
		if (problem && messages[problem.error])
			return messages[problem.error] as string;
	}
	return "Couldn’t reach Interview Studio. Try again.";
}

export function useCommandKey() {
	const previous = useRef<{ fingerprint: string; commandId: string } | null>(
		null,
	);
	return <T extends object>(input: T) => {
		const fingerprint = JSON.stringify(input);
		if (previous.current?.fingerprint !== fingerprint) {
			previous.current = { fingerprint, commandId: crypto.randomUUID() };
		}
		return { ...input, commandId: previous.current.commandId };
	};
}

export function useInterviewResource<T extends z.ZodType>(
	path: string | null,
	schema: T,
	{
		delay = 0,
		keepPrevious = false,
	}: { delay?: number; keepPrevious?: boolean } = {},
) {
	type Result = {
		path: string;
		reload: number;
		data?: z.output<T>;
		error?: unknown;
	};
	const [result, setResult] = useState<Result>();
	const [reload, setReload] = useState(0);
	useEffect(() => {
		if (!path) return;
		const controller = new AbortController();
		const handle = window.setTimeout(() => {
			void interviewRequest(path, schema, { signal: controller.signal })
				.then((data) => {
					if (!controller.signal.aborted) setResult({ path, reload, data });
				})
				.catch((error: unknown) => {
					if (!controller.signal.aborted)
						setResult((previous) => ({
							path,
							reload,
							error,
							data:
								keepPrevious && !accessDenied(error)
									? previous?.data
									: undefined,
						}));
				});
		}, delay);
		return () => {
			window.clearTimeout(handle);
			controller.abort();
		};
	}, [path, schema, delay, keepPrevious, reload]);
	return {
		data:
			path && (result?.path === path || keepPrevious)
				? result?.data
				: undefined,
		error:
			result?.path === path && result.reload === reload
				? result.error
				: undefined,
		loading: Boolean(
			path && (result?.path !== path || result.reload !== reload),
		),
		refresh: () => setReload((value) => value + 1),
	};
}

export function useInterviewPoll<
	T extends z.ZodType<{ state: string; confirmed?: boolean }>,
>(
	path: string | null,
	schema: T,
	{
		candidate = false,
		refresh = 0,
	}: { candidate?: boolean; refresh?: number } = {},
) {
	type Result = {
		path: string;
		data?: z.output<T>;
		error?: unknown;
		terminal?: boolean;
	};
	const [result, setResult] = useState<Result>();
	// biome-ignore lint/correctness/useExhaustiveDependencies: Refresh restarts polling after a command.
	useEffect(() => {
		if (!path) return;
		const controller = new AbortController();
		let timer = 0;
		let failures = 0;
		async function update(endpoint: string, heartbeat = false) {
			try {
				const data = await interviewRequest(
					heartbeat ? `${endpoint}/presence` : endpoint,
					schema,
					{
						signal: controller.signal,
						data: heartbeat ? {} : undefined,
					},
				);
				if (controller.signal.aborted) return;
				failures = 0;
				setResult({ path: endpoint, data });
				if (
					data.state === "scheduled" ||
					data.state === "active" ||
					(!candidate && data.state === "awaiting_feedback")
				) {
					timer = window.setTimeout(
						() => void update(endpoint, candidate && data.confirmed),
						8_000,
					);
				}
			} catch (error) {
				if (controller.signal.aborted) return;
				const terminal = accessDenied(error);
				setResult((previous) => ({
					path: endpoint,
					data:
						!terminal && previous?.path === endpoint
							? previous.data
							: undefined,
					error,
					terminal,
				}));
				if (!terminal) {
					failures += 1;
					timer = window.setTimeout(
						() => void update(endpoint, heartbeat),
						Math.min(8_000 * 2 ** failures, 60_000),
					);
				}
			}
		}
		void update(path);
		return () => {
			controller.abort();
			window.clearTimeout(timer);
		};
	}, [path, schema, candidate, refresh]);
	return result?.path === path ? result : undefined;
}
