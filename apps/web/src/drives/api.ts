import {
	type DriveError,
	documentStatusSchema,
	driveErrorSchema,
	driveIntakeSchema,
	driveOverviewSchema,
	drivePageSchema,
} from "@studio/contracts";
import { useCallback, useEffect, useRef } from "react";
import { z } from "zod";

const base = "/api/staff/drives";
export const driveListSchema = drivePageSchema(driveOverviewSchema);
export const documentListSchema = drivePageSchema(documentStatusSchema).extend({
	intake: driveIntakeSchema,
});
export const createdDriveSchema = z.object({ id: z.uuid() });

export class DriveRequestError extends Error {
	readonly problem: DriveError;
	readonly retryAfter: number;

	constructor(problem: DriveError, retryAfter: number) {
		super(problem.error);
		this.problem = problem;
		this.retryAfter = retryAfter;
	}
}

const messages: Partial<Record<DriveError["error"], string>> = {
	not_found: "This drive or record could not be found.",
	invalid_input: "Check the highlighted values and try again.",
	invalid_file: "Choose a file with a valid name and contents.",
	unsupported_file:
		"Choose a supported file whose contents match its extension.",
	file_too_large:
		"This file exceeds the upload limit. Choose a smaller document.",
	upload_timeout: "The upload took too long.",
	upload_busy: "Two uploads are already being received.",
	upload_rate_limit: "You’ve reached the upload rate limit.",
	intake_full: "The intake queue is full.",
	idempotency_conflict:
		"This request key was already used with different details.",
	upload_retry_required:
		"The previous attempt expired or failed. Start a new attempt.",
	revision_conflict: "Someone saved a newer version while you were editing.",
	interview_email_in_use:
		"Cancel the upcoming interview or close the active round before changing this email.",
	duplicate_email:
		"A confirmed candidate in this drive already uses this email.",
	invalid_review:
		"This record no longer meets the requirements for that review action.",
	storage_unavailable: "File storage is temporarily unavailable.",
	queue_unavailable: "The processing queue is temporarily unavailable.",
	original_missing: "The original is missing from storage.",
};

export function requestMessage(error: unknown) {
	if (!(error instanceof DriveRequestError))
		return "Couldn’t complete the request. Try again.";
	const message =
		messages[error.problem.error] ??
		"Couldn’t complete the request. Try again.";
	if (!error.retryAfter) return message;
	return `${message} Try again in ${error.retryAfter} seconds.`;
}

export function useDriveRequest() {
	const scope = useRef<AbortController>(null);
	useEffect(() => {
		const controller = new AbortController();
		scope.current = controller;
		return () => controller.abort();
	}, []);
	return useCallback(async function request<T extends z.ZodType>(
		path: string,
		schema: T,
		options: RequestInit = {},
	): Promise<z.output<T>> {
		const signals = [
			scope.current?.signal,
			options.signal,
			AbortSignal.timeout(55_000),
		].filter((signal) => signal != null);
		const signal = AbortSignal.any(signals);
		const response = await fetch(base + path, {
			...options,
			cache: "no-store",
			signal,
		});
		const data: unknown = await response.json();
		signal.throwIfAborted();
		if (!response.ok) {
			const problem = driveErrorSchema.safeParse(data);
			if (response.status === 401) window.location.replace("/sign-in");
			if (problem.success) {
				if (problem.data.error === "forbidden") window.location.reload();
				throw new DriveRequestError(
					problem.data,
					Number(response.headers.get("retry-after")) || 0,
				);
			}
			throw new Error("Drive request failed");
		}
		return schema.parse(data);
	}, []);
}

export type DriveRequest = ReturnType<typeof useDriveRequest>;

export function jsonRequest(
	method: string,
	body: unknown,
	headers?: Record<string, string>,
) {
	return {
		method,
		headers: { "Content-Type": "application/json", ...headers },
		body: JSON.stringify(body),
	};
}

export function originalUrl(driveId: string, documentId: string) {
	return `${base}/${driveId}/documents/${documentId}/original`;
}

export function wordPreviewUrl(driveId: string, documentId: string) {
	return `${base}/${driveId}/documents/${documentId}/preview`;
}
