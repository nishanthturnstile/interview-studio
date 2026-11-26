import {
	type Candidate,
	candidateSchema,
	type DocumentStatus,
	type ReviewQueueItem,
} from "@studio/contracts";
import { cn } from "cn";
import { ChevronLeft, ChevronRight, Eye } from "lucide-react";
import {
	memo,
	type RefObject,
	useCallback,
	useEffect,
	useRef,
	useState,
} from "react";
import { Alert, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import {
	Sheet,
	SheetContent,
	SheetDescription,
	SheetFooter,
	SheetHeader,
	SheetTitle,
} from "@/components/ui/sheet";
import { type DriveRequest, documentListSchema, requestMessage } from "./api";
import { CandidateEditor } from "./candidate";
import { DocumentHeader, isPending } from "./document";
import { ResumeViewer } from "./resume-document";

const CandidateDetails = memo(function CandidateDetails({
	item,
	outsidePage,
	driveId,
	request,
	previewOpen,
	onShowPreview,
	onHidePreview,
	previewButton,
	backButton,
	scrollPane,
	navigationError,
	onSaved,
	onDirty,
	onPending,
}: {
	item: ReviewQueueItem;
	outsidePage: boolean;
	driveId: string;
	request: DriveRequest;
	previewOpen: boolean;
	onShowPreview: () => void;
	onHidePreview: () => void;
	previewButton: RefObject<HTMLButtonElement | null>;
	backButton: RefObject<HTMLButtonElement | null>;
	scrollPane: RefObject<HTMLElement | null>;
	navigationError: string;
	onSaved: () => void;
	onDirty: (key: string, dirty: boolean) => void;
	onPending: (pending: boolean) => void;
}) {
	const [detail, setDetail] = useState<Candidate>();
	const [error, setError] = useState("");
	const [retry, setRetry] = useState(0);
	const [offPageDocument, setOffPageDocument] = useState<DocumentStatus>();
	const document = outsidePage
		? (offPageDocument ?? item.document)
		: item.document;
	const lookUp = outsidePage && isPending(document) ? document.id : null;
	// A resume can leave the Processing filter exactly when its extraction
	// completes. Follow just that open document until it reaches a final state.
	useEffect(() => {
		if (!lookUp) {
			if (!outsidePage) setOffPageDocument(undefined);
			return;
		}
		const controller = new AbortController();
		let timer: number;
		async function refresh() {
			try {
				const page = await request(
					`/${driveId}/documents?ids=${lookUp}`,
					documentListSchema,
					{ signal: controller.signal },
				);
				if (controller.signal.aborted) return;
				const current = page.items[0];
				if (current) setOffPageDocument(current);
				if (current && !isPending(current)) return;
			} catch (error) {
				if (controller.signal.aborted) return;
				setError(requestMessage(error));
			}
			timer = window.setTimeout(refresh, 3000);
		}
		void refresh();
		return () => {
			controller.abort();
			window.clearTimeout(timer);
		};
	}, [driveId, lookUp, outsidePage, request]);
	const candidateId = document.candidateId;
	const path = candidateId ? `/${driveId}/candidates/${candidateId}` : null;
	// Extraction can finish while HR is editing the record. Keep the editor
	// mounted and refresh its source text when the processing state changes.
	// biome-ignore lint/correctness/useExhaustiveDependencies: Re-read this candidate when extraction finishes, its revision changes, or HR retries.
	useEffect(() => {
		if (!path) return;
		const controller = new AbortController();
		setError("");
		void request(path, candidateSchema, { signal: controller.signal })
			.then((current) => {
				setDetail((previous) =>
					previous && previous.revision > current.revision ? previous : current,
				);
			})
			.catch((error: unknown) => {
				if (!controller.signal.aborted) setError(requestMessage(error));
			});
		return () => controller.abort();
	}, [document.parseState, item.candidate?.revision, path, request, retry]);
	return (
		<div
			className={cn(
				"grid min-h-0 min-w-0 flex-1 grid-rows-[minmax(0,1fr)]",
				previewOpen && "lg:grid-cols-[minmax(0,1.55fr)_minmax(22rem,1fr)]",
			)}
		>
			{previewOpen && (
				<ResumeViewer
					driveId={driveId}
					document={document}
					onClose={onHidePreview}
					closeButton={backButton}
				/>
			)}
			<section
				ref={scrollPane}
				aria-label="Candidate details"
				className={cn(
					"min-h-0 min-w-0 flex-col gap-4 overflow-y-auto overscroll-contain px-5 py-5 sm:px-6",
					previewOpen ? "hidden lg:flex" : "flex",
				)}
			>
				<DocumentHeader
					driveId={driveId}
					document={document}
					showDownload={!previewOpen}
					preview={
						!previewOpen && (
							<Button ref={previewButton} size="sm" onClick={onShowPreview}>
								<Eye aria-hidden="true" /> View resume
							</Button>
						)
					}
				/>
				{error && (
					<Alert variant="destructive">
						<AlertTitle>{error}</AlertTitle>
						<Button
							size="sm"
							variant="outline"
							onClick={() => setRetry((value) => value + 1)}
						>
							Retry candidate
						</Button>
					</Alert>
				)}
				{detail ? (
					<CandidateEditor
						candidate={detail}
						driveId={driveId}
						request={request}
						onDirty={onDirty}
						onPending={onPending}
						onSaved={(updated) => {
							setDetail((previous) => ({
								...updated,
								suggestions:
									updated.suggestions ?? previous?.suggestions ?? null,
								extractedText:
									updated.extractedText ?? previous?.extractedText ?? null,
							}));
							onSaved();
						}}
					/>
				) : (
					!error && (
						<p className="text-sm text-muted-foreground" role="status">
							{candidateId
								? "Loading candidate…"
								: document.uploadState === "pending"
									? "The candidate record will appear once the upload finishes."
									: "No candidate record is available for this upload."}
						</p>
					)
				)}
				{navigationError && (
					<Alert variant="destructive">
						<AlertTitle>{navigationError}</AlertTitle>
					</Alert>
				)}
			</section>
		</div>
	);
});

export function ReviewSheet({
	item,
	outsidePage,
	driveId,
	request,
	onSaved,
	onDirty,
	onClose,
	canPrevious,
	canNext,
	onMove,
	position,
	returnFocus,
}: {
	item: ReviewQueueItem | undefined;
	outsidePage: boolean;
	driveId: string;
	request: DriveRequest;
	onSaved: () => void;
	onDirty: (key: string, dirty: boolean) => void;
	onClose: () => void;
	canPrevious: boolean;
	canNext: boolean;
	onMove: (direction: -1 | 1) => Promise<void>;
	position: string;
	returnFocus: () => HTMLElement | null;
}) {
	const [discard, setDiscard] = useState<"close" | -1 | 1>();
	const [saving, setSaving] = useState(false);
	const [moving, setMoving] = useState(false);
	const [error, setError] = useState("");
	const [previewOpen, setPreviewOpen] = useState(false);
	const dirty = useRef(false);
	const scrollPane = useRef<HTMLElement>(null);
	const title = useRef<HTMLHeadingElement>(null);
	const previewButton = useRef<HTMLButtonElement>(null);
	const backButton = useRef<HTMLButtonElement>(null);
	const focusPreview = useRef(false);
	const showPreview = useCallback(() => {
		focusPreview.current = true;
		setPreviewOpen(true);
	}, []);
	const hidePreview = useCallback(() => {
		focusPreview.current = true;
		setPreviewOpen(false);
	}, []);
	useEffect(() => {
		if (!focusPreview.current) return;
		focusPreview.current = false;
		if (previewOpen) backButton.current?.focus({ preventScroll: true });
		else (previewButton.current ?? title.current)?.focus();
	}, [previewOpen]);
	const trackDirty = useCallback(
		(key: string, value: boolean) => {
			dirty.current = value;
			onDirty(key, value);
		},
		[onDirty],
	);
	async function act(action: "close" | -1 | 1) {
		setDiscard(undefined);
		setError("");
		if (action === "close") {
			setPreviewOpen(false);
			onClose();
			return;
		}
		setMoving(true);
		try {
			await onMove(action);
			scrollPane.current?.scrollTo(0, 0);
			title.current?.focus();
		} catch (error) {
			setError(requestMessage(error));
		} finally {
			setMoving(false);
		}
	}
	function navigate(action: "close" | -1 | 1) {
		if (saving || moving) return;
		if (dirty.current) setDiscard(action);
		else void act(action);
	}
	return (
		<Sheet
			open={Boolean(item)}
			onOpenChange={(open, details) => {
				if (open) return;
				if (
					previewOpen &&
					details.reason === "escape-key" &&
					discard === undefined
				) {
					details.cancel();
					hidePreview();
				} else navigate("close");
			}}
		>
			<SheetContent
				finalFocus={returnFocus}
				initialFocus={title}
				className={cn(
					"gap-0 data-[side=right]:w-full data-[side=right]:sm:max-w-xl",
					previewOpen && "data-[side=right]:lg:max-w-[min(96vw,88rem)]",
				)}
			>
				<SheetHeader className="shrink-0 gap-1 border-b px-5 py-4 pr-16 sm:px-6">
					<SheetTitle ref={title} tabIndex={-1} className="outline-none">
						Review candidate
					</SheetTitle>
					<SheetDescription>{position}</SheetDescription>
				</SheetHeader>
				{item && (
					<CandidateDetails
						outsidePage={outsidePage}
						key={item.document.id}
						item={item}
						driveId={driveId}
						request={request}
						previewOpen={previewOpen}
						onShowPreview={showPreview}
						onHidePreview={hidePreview}
						previewButton={previewButton}
						backButton={backButton}
						scrollPane={scrollPane}
						navigationError={error}
						onSaved={onSaved}
						onDirty={trackDirty}
						onPending={setSaving}
					/>
				)}
				<SheetFooter className="shrink-0 flex-row justify-between border-t bg-card px-5 py-3 sm:px-6">
					<Button
						variant="outline"
						size="sm"
						aria-label="Previous resume"
						disabled={!canPrevious || moving || saving}
						onClick={() => navigate(-1)}
					>
						<ChevronLeft aria-hidden="true" />
						Previous
					</Button>
					<Button
						variant="outline"
						size="sm"
						aria-label="Next resume"
						disabled={!canNext || moving || saving}
						onClick={() => navigate(1)}
					>
						Next resume
						<ChevronRight aria-hidden="true" />
					</Button>
				</SheetFooter>
				<Dialog
					open={discard !== undefined}
					onOpenChange={(open) => {
						if (!open) setDiscard(undefined);
					}}
				>
					<DialogContent forceBackdrop>
						<DialogHeader>
							<DialogTitle>Discard candidate edits?</DialogTitle>
							<DialogDescription>
								Your changes to this candidate haven’t been saved.
							</DialogDescription>
						</DialogHeader>
						<DialogFooter>
							<Button variant="outline" onClick={() => setDiscard(undefined)}>
								Keep editing
							</Button>
							<Button
								variant="destructive"
								onClick={() => {
									if (discard !== undefined) void act(discard);
								}}
							>
								Discard edits
							</Button>
						</DialogFooter>
					</DialogContent>
				</Dialog>
			</SheetContent>
		</Sheet>
	);
}
