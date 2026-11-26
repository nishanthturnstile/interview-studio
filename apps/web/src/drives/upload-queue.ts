import {
	type DocumentKind,
	type DocumentStatus,
	documentBytes,
	documentMediaForFilename,
	documentStatusSchema,
	selectionLimit,
} from "@studio/contracts";
import { useEffect, useRef, useState } from "react";
import { type DriveRequest, DriveRequestError, requestMessage } from "./api";

type QueueItem = {
	id: string;
	key: string;
	file: File;
	kind: DocumentKind;
	jdRevision: number;
	state: "waiting" | "uploading" | "receiving" | "accepted" | "failed";
	documentId?: string;
	error?: string;
	newAttempt?: boolean;
	refreshRevision?: boolean;
	retryAt?: number;
};
const concurrent = 2;

export function useUploads(
	driveId: string,
	jdRevision: number,
	request: DriveRequest,
	documents: DocumentStatus[],
	onAccepted: (document: DocumentStatus) => void,
	onRevisionConflict: () => void,
) {
	const [items, setItems] = useState<QueueItem[]>([]);
	const [error, setError] = useState("");
	const active = useRef(new Set<string>());

	function add(files: File[], kind: DocumentKind) {
		if (files.length > selectionLimit) {
			setError(`Select up to ${selectionLimit} resumes at a time.`);
			return;
		}
		setError("");
		const additions = files.map((file): QueueItem => {
			const issue = !file.size
				? "This file is empty."
				: file.size > documentBytes
					? "Choose a file up to 10 MiB."
					: !documentMediaForFilename(file.name, kind)
						? kind === "resume"
							? "Choose a PDF, DOCX, PNG, or JPEG."
							: "Choose a PDF or DOCX."
						: undefined;
			const id = crypto.randomUUID();
			return {
				id,
				key: id,
				file,
				kind,
				jdRevision,
				state: issue ? "failed" : "waiting",
				error: issue,
			};
		});
		setItems((current) => [
			...current.filter((item) => item.state !== "accepted"),
			...additions,
		]);
	}

	function retry(id: string) {
		setItems((current) =>
			current.map((item) => {
				if (
					item.id !== id ||
					item.state !== "failed" ||
					(item.retryAt && Date.now() < item.retryAt)
				)
					return item;
				return {
					...item,
					state: "waiting",
					error: undefined,
					retryAt: undefined,
					key: item.newAttempt ? crypto.randomUUID() : item.key,
					jdRevision: item.refreshRevision ? jdRevision : item.jdRevision,
				};
			}),
		);
	}

	function remove(id: string) {
		setItems((current) => current.filter((item) => item.id !== id));
	}

	useEffect(() => {
		function start(item: QueueItem) {
			active.current.add(item.id);
			setItems((current) =>
				current.map((entry) =>
					entry.id === item.id ? { ...entry, state: "uploading" } : entry,
				),
			);
			const headers: Record<string, string> = {
				"X-Upload-Filename": encodeURIComponent(item.file.name),
				"Idempotency-Key": item.key,
			};
			if (item.file.type) headers["Content-Type"] = item.file.type;
			if (item.kind === "job_description")
				headers["X-JD-Revision"] = String(item.jdRevision);
			void request(
				`/${driveId}/documents?kind=${item.kind}`,
				documentStatusSchema,
				{
					method: "POST",
					headers,
					body: item.file,
				},
			)
				.then((document) => {
					active.current.delete(item.id);
					setItems((current) =>
						current.map((entry) =>
							entry.id === item.id
								? {
										...entry,
										documentId: document.id,
										state:
											document.uploadState === "pending"
												? "receiving"
												: "accepted",
									}
								: entry,
						),
					);
					onAccepted(document);
				})
				.catch((error: unknown) => {
					active.current.delete(item.id);
					const code =
						error instanceof DriveRequestError
							? error.problem.error
							: undefined;
					const refreshRevision = code === "revision_conflict";
					if (refreshRevision) onRevisionConflict();
					const retryAfter =
						error instanceof DriveRequestError ? error.retryAfter : 0;
					setItems((current) =>
						current.map((entry) =>
							entry.id === item.id
								? {
										...entry,
										state: "failed",
										error: requestMessage(error),
										refreshRevision,
										newAttempt:
											refreshRevision ||
											code === "upload_retry_required" ||
											code === "storage_unavailable" ||
											code === "queue_unavailable",
										retryAt: retryAfter
											? Date.now() + retryAfter * 1000
											: undefined,
									}
								: entry,
						),
					);
				});
		}
		const available = concurrent - active.current.size;
		if (available <= 0) return;
		for (const item of items
			.filter(
				(entry) => entry.state === "waiting" && !active.current.has(entry.id),
			)
			.slice(0, available))
			start(item);
	}, [driveId, items, onAccepted, onRevisionConflict, request]);

	useEffect(() => {
		setItems((current) => {
			let changed = false;
			const next = current.map((item): QueueItem => {
				if (item.state !== "receiving") return item;
				const stored = documents.find(({ id }) => id === item.documentId);
				if (!stored || stored.uploadState === "pending") return item;
				changed = true;
				if (
					stored.uploadState === "failed" ||
					(stored.uploadState === "cleanup" && !stored.parseState)
				) {
					return {
						...item,
						state: "failed",
						newAttempt: true,
						error:
							"The previous attempt expired or failed. Start a new attempt.",
					};
				}
				return { ...item, state: "accepted" };
			});
			return changed ? next : current;
		});
	}, [documents]);

	// Re-render when Retry-After ends without sending an automatic duplicate request.
	useEffect(() => {
		const next = Math.min(
			...items.flatMap((item) =>
				item.retryAt && item.retryAt > Date.now() ? [item.retryAt] : [],
			),
		);
		if (!Number.isFinite(next)) return;
		const timer = window.setTimeout(
			() => setItems((current) => [...current]),
			Math.max(0, next - Date.now()),
		);
		return () => window.clearTimeout(timer);
	}, [items]);

	return { items, error, add, retry, remove };
}
