import {
	type DocumentKind,
	type DocumentStatus,
	type DriveIntake,
	documentUploadTypes,
	statusLookupLimit,
} from "@studio/contracts";
import { cn } from "cn";
import { CloudUpload, Files, FolderOpen, Paperclip } from "lucide-react";
import { memo, useCallback, useEffect, useId, useRef, useState } from "react";
import { Alert, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { type DriveRequest, documentListSchema, requestMessage } from "./api";
import { DocumentHeader, isPending } from "./document";
import { JobDescriptionEditor } from "./job-description";
import { ReviewQueue } from "./review-queue";
import { useUploads } from "./upload-queue";

function FilePicker({
	kind,
	uploads,
	hasJd,
}: {
	kind: DocumentKind;
	uploads: ReturnType<typeof useUploads>;
	hasJd?: boolean;
}) {
	const id = useId();
	const input = useRef<HTMLInputElement>(null);
	const dragDepth = useRef(0);
	const [dragging, setDragging] = useState(false);
	const multiple = kind === "resume";
	const items = uploads.items.filter(
		(item) =>
			item.kind === kind &&
			item.state !== "accepted" &&
			item.state !== "receiving",
	);
	const blocked =
		!multiple &&
		uploads.items.some(
			(item) =>
				item.kind === kind &&
				(item.state === "uploading" ||
					item.state === "waiting" ||
					item.state === "receiving"),
		);
	return (
		<div className={cn("flex min-w-0 flex-col gap-3", multiple && "flex-1")}>
			<Input
				ref={input}
				className="hidden"
				type="file"
				accept={Object.keys(documentUploadTypes(kind)).join(",")}
				multiple={multiple}
				disabled={blocked}
				aria-label={
					multiple
						? "Choose resumes"
						: hasJd
							? "Replace job description"
							: "Choose job description"
				}
				onChange={(event) => {
					const files = Array.from(event.currentTarget.files ?? []);
					if (files.length) uploads.add(files, kind);
					event.currentTarget.value = "";
				}}
			/>
			{multiple ? (
				// biome-ignore lint/a11y/noStaticElementInteractions: File dropping supplements the keyboard-accessible Browse files button.
				<div
					id="resume-dropzone"
					className={cn(
						"flex min-h-48 flex-1 flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-input bg-muted/35 px-4 py-5 text-center transition-colors",
						dragging && "border-primary bg-accent",
					)}
					onDragEnter={(event) => {
						if (!event.dataTransfer.types.includes("Files")) return;
						event.preventDefault();
						dragDepth.current += 1;
						setDragging(true);
					}}
					onDragOver={(event) => {
						if (!event.dataTransfer.types.includes("Files")) return;
						event.preventDefault();
						event.dataTransfer.dropEffect = "copy";
					}}
					onDragLeave={() => {
						dragDepth.current = Math.max(0, dragDepth.current - 1);
						if (!dragDepth.current) setDragging(false);
					}}
					onDrop={(event) => {
						event.preventDefault();
						dragDepth.current = 0;
						setDragging(false);
						const files = Array.from(event.dataTransfer.files);
						if (files.length) uploads.add(files, kind);
					}}
				>
					<span className="grid size-11 shrink-0 place-items-center rounded-xl bg-accent text-accent-foreground">
						<CloudUpload className="size-5" aria-hidden="true" />
					</span>
					<p aria-live="polite" className="text-base font-semibold">
						{dragging ? "Release to upload" : "Drag and drop resumes"}
					</p>
					<Button
						type="button"
						aria-describedby={id}
						onClick={() => input.current?.click()}
					>
						<FolderOpen data-icon="inline-start" aria-hidden="true" /> Browse
						files
					</Button>
					<p id={id} className="text-xs leading-relaxed text-muted-foreground">
						PDF, DOCX, PNG, or JPEG.
						<span className="block">Up to 20 files, 10 MiB each.</span>
					</p>
				</div>
			) : (
				<div className="flex flex-wrap items-center gap-x-3 gap-y-1">
					<Button
						type="button"
						size="sm"
						variant="outline"
						aria-describedby={id}
						disabled={blocked}
						onClick={() => input.current?.click()}
					>
						<Paperclip aria-hidden="true" />
						{hasJd ? "Replace file" : "Import file"}
					</Button>
					<p id={id} className="text-xs text-muted-foreground">
						PDF or DOCX up to 10 MiB.
					</p>
				</div>
			)}
			{multiple && uploads.error && (
				<Alert variant="destructive">
					<AlertTitle>{uploads.error}</AlertTitle>
				</Alert>
			)}
			{items.length > 0 && (
				<ul className="flex flex-col gap-2 text-sm">
					{items.map((item) => (
						<li
							key={item.id}
							className="flex flex-wrap items-center gap-3 rounded-md border p-3"
						>
							<span className="min-w-0 flex-1 font-medium [overflow-wrap:anywhere]">
								{item.file.name}
							</span>
							{item.state === "failed" ? (
								<>
									<p role="alert" className="w-full text-destructive">
										{item.error}
									</p>
									<Button
										size="sm"
										variant="outline"
										disabled={Boolean(
											item.retryAt && Date.now() < item.retryAt,
										)}
										onClick={() => uploads.retry(item.id)}
									>
										Retry upload
									</Button>
									<Button
										size="sm"
										variant="ghost"
										onClick={() => uploads.remove(item.id)}
									>
										Dismiss
									</Button>
								</>
							) : (
								<Badge role="status" variant="secondary">
									{item.state === "waiting" ? "Waiting" : "Uploading…"}
								</Badge>
							)}
						</li>
					))}
				</ul>
			)}
		</div>
	);
}

export const Intake = memo(function Intake({
	driveId,
	request,
	onOverviewChange,
	onDirty,
}: {
	driveId: string;
	request: DriveRequest;
	onOverviewChange: () => void;
	onDirty: (key: string, dirty: boolean) => void;
}) {
	const [intake, setIntake] = useState<DriveIntake>();
	const [documents, setDocuments] = useState<DocumentStatus[]>([]);
	const [queueRefresh, setQueueRefresh] = useState(0);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState("");
	const [pollError, setPollError] = useState("");

	const applyStatuses = useCallback(
		(items: DocumentStatus[], intake: DriveIntake) => {
			setIntake((current) =>
				!current || intake.jdRevision >= current.jdRevision ? intake : current,
			);
			setDocuments((current) => {
				const updated = new Map(items.map((item) => [item.id, item]));
				const merged = current.map((item) => {
					const latest = updated.get(item.id);
					if (!latest || latest.parseAttempts < item.parseAttempts) return item;
					if (
						latest.uploadState === "pending" &&
						item.uploadState !== "pending"
					)
						return item;
					if (
						latest.uploadState === "stored" &&
						item.uploadState === "stored" &&
						!isPending(item) &&
						isPending(latest)
					)
						return item;
					return latest;
				});
				const existingIds = new Set(current.map(({ id }) => id));
				const additions = items.filter(({ id }) => !existingIds.has(id));
				return [...additions, ...merged];
			});
		},
		[],
	);

	const load = useCallback(
		async (signal?: AbortSignal) => {
			setLoading(true);
			setError("");
			try {
				const data = await request(
					`/${driveId}/documents?kind=job_description`,
					documentListSchema,
					{ signal },
				);
				const items = data.items.filter(
					(item) => item.kind === "job_description",
				);
				if (
					data.intake.activeJdId &&
					!items.some(({ id }) => id === data.intake.activeJdId)
				) {
					const extra = await request(
						`/${driveId}/documents?ids=${data.intake.activeJdId}`,
						documentListSchema,
						{ signal },
					);
					items.push(...extra.items);
					data.intake = extra.intake;
				}
				applyStatuses(items, data.intake);
			} catch (error) {
				if (!signal?.aborted) setError(requestMessage(error));
			} finally {
				if (!signal?.aborted) setLoading(false);
			}
		},
		[applyStatuses, driveId, request],
	);

	useEffect(() => {
		const controller = new AbortController();
		void load(controller.signal);
		return () => controller.abort();
	}, [load]);

	const pollKey = documents
		.filter((item) =>
			item.kind === "job_description"
				? isPending(item)
				: item.uploadState === "pending",
		)
		.slice(0, statusLookupLimit)
		.map(({ id }) => id)
		.join(",");
	useEffect(() => {
		if (!pollKey) return;
		const controller = new AbortController();
		const { signal } = controller;
		let timer: number;
		let interval = 1200;
		async function poll() {
			try {
				const result = await request(
					`/${driveId}/documents?ids=${pollKey}`,
					documentListSchema,
					{ signal },
				);
				const settled = result.items.filter((document) => !isPending(document));
				if (settled.length) {
					if (settled.some((item) => item.kind === "resume"))
						setQueueRefresh((value) => value + 1);
					onOverviewChange();
				}
				applyStatuses(result.items, result.intake);
				setPollError("");
				interval = 1200;
			} catch (error) {
				if (!signal.aborted) setPollError(requestMessage(error));
				interval = Math.min(interval * 2, 15_000);
			}
			if (!signal.aborted) timer = window.setTimeout(poll, interval);
		}
		timer = window.setTimeout(poll, interval);
		return () => {
			controller.abort();
			window.clearTimeout(timer);
		};
	}, [applyStatuses, driveId, onOverviewChange, pollKey, request]);

	const accepted = useCallback(
		(document: DocumentStatus) => {
			if (
				document.kind === "job_description" ||
				document.uploadState === "pending"
			) {
				setDocuments((current) => [
					document,
					...current.filter(({ id }) => id !== document.id),
				]);
			}
			if (document.kind === "job_description") void load();
			else setQueueRefresh((value) => value + 1);
			onOverviewChange();
		},
		[load, onOverviewChange],
	);
	const revisionConflict = useCallback(() => {
		void load();
	}, [load]);
	const uploads = useUploads(
		driveId,
		intake?.jdRevision ?? 0,
		request,
		documents,
		accepted,
		revisionConflict,
	);
	const jd = documents.find((item) => item.id === intake?.activeJdId);
	const pendingJds = documents.filter(
		(item) => item.kind === "job_description" && item.uploadState === "pending",
	);

	return (
		<div className="flex flex-col gap-5">
			{error && (
				<Alert variant="destructive">
					<AlertTitle>{error}</AlertTitle>
					<Button size="sm" variant="outline" onClick={() => void load()}>
						Reload intake
					</Button>
				</Alert>
			)}
			{pollError && (
				<Alert variant="destructive">
					<AlertTitle>Intake updates are delayed. {pollError}</AlertTitle>
				</Alert>
			)}
			<div className="grid min-w-0 gap-4 @min-[43rem]/drive:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)] @min-[43rem]/drive:gap-5">
				<JobDescriptionEditor
					driveId={driveId}
					request={request}
					refreshKey={
						intake &&
						`${intake.jdRevision}:${jd?.id ?? ""}:${jd?.parseState ?? ""}`
					}
					onDirty={onDirty}
					onSaved={(updated) =>
						setIntake((current) =>
							!current || updated.jdRevision >= current.jdRevision
								? updated
								: current,
						)
					}
					source={
						<>
							{intake && (
								<FilePicker
									kind="job_description"
									uploads={uploads}
									hasJd={Boolean(jd)}
								/>
							)}
							{jd && <DocumentHeader document={jd} driveId={driveId} />}
							{pendingJds.map((document) => (
								<DocumentHeader
									key={document.id}
									document={document}
									driveId={driveId}
								/>
							))}
						</>
					}
				/>
				<Card
					id="resume-intake"
					size="sm"
					className="min-w-0 scroll-mt-6 gap-3"
				>
					<CardHeader>
						<CardTitle>
							<h2 className="flex items-center gap-2">
								<Files
									className="size-4 shrink-0 text-muted-foreground"
									aria-hidden="true"
								/>
								Resume intake
							</h2>
						</CardTitle>
					</CardHeader>
					<CardContent className="flex flex-1 flex-col">
						{intake ? (
							<FilePicker kind="resume" uploads={uploads} />
						) : (
							<p role="status" className="text-muted-foreground">
								{loading ? "Loading intake…" : "Intake is unavailable."}
							</p>
						)}
					</CardContent>
				</Card>
			</div>
			<ReviewQueue
				driveId={driveId}
				request={request}
				uploadRevision={queueRefresh}
				onDirty={onDirty}
				onOverviewChange={onOverviewChange}
			/>
		</div>
	);
});
