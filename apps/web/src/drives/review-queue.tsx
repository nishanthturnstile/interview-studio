import {
	type ReviewQueueItem,
	type ReviewQueueStatus,
	reviewQueueSchema,
	reviewQueueStatusSchema,
} from "@studio/contracts";
import {
	ChevronLeft,
	ChevronRight,
	CircleAlert,
	CircleCheck,
	Clock3,
	Files,
	FileText,
	ListFilter,
	Search,
} from "lucide-react";
import { memo, useCallback, useEffect, useId, useRef, useState } from "react";
import type { z } from "zod";
import { Alert, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { type DriveRequest, requestMessage } from "./api";
import { reviewLabel } from "./candidate";
import { documentLabel } from "./document";
import { ReviewSheet } from "./review-sheet";

type QueuePage = z.infer<typeof reviewQueueSchema>;
const statusLabels: Record<ReviewQueueStatus, string> = {
	all: "All statuses",
	draft: "Draft",
	confirmed: "Confirmed",
	duplicate: "Duplicate",
	needs_attention: "Needs attention",
	processing: "Processing",
};

const QueueRow = memo(function QueueRow({
	item,
	offset,
	onOpen,
}: {
	item: ReviewQueueItem;
	offset: number;
	onOpen: (
		item: ReviewQueueItem,
		offset: number,
		element: HTMLButtonElement,
	) => void;
}) {
	const { document, candidate } = item;
	const descriptionId = useId();
	const name = candidate?.name;
	const subtitle = name
		? document.filename
		: candidate?.suggestions?.name
			? `Suggested name: ${candidate.suggestions.name}`
			: undefined;
	const missing =
		candidate?.reviewState === "draft" && document.parseState === "succeeded"
			? [
					!(candidate.name || candidate.suggestions?.name) && "name",
					!(candidate.email || candidate.suggestions?.email) && "email",
				]
					.filter(Boolean)
					.join(" and ")
			: "";
	const attention =
		document.parseState === "needs_manual_review" ||
		document.uploadState === "failed" ||
		document.uploadState === "cleanup";
	const ExtractionIcon =
		attention || missing
			? CircleAlert
			: document.parseState === "succeeded"
				? CircleCheck
				: Clock3;
	return (
		<li>
			<button
				type="button"
				aria-label={`Review ${document.filename}`}
				aria-haspopup="dialog"
				aria-describedby={`${descriptionId}-identity ${descriptionId}-extraction ${descriptionId}-review`}
				className="group grid w-full min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1.5 px-3 py-2.5 text-left hover:bg-muted/50 focus-visible:relative focus-visible:z-10 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring sm:grid-cols-[minmax(0,1fr)_10.75rem_6rem_1rem] sm:gap-x-4 sm:px-5"
				onClick={(event) => onOpen(item, offset, event.currentTarget)}
			>
				<span className="flex min-w-0 items-center gap-3">
					<span className="hidden size-8 shrink-0 items-center justify-center rounded-md border bg-background text-muted-foreground sm:flex">
						<FileText className="size-4" aria-hidden="true" />
					</span>
					<span
						id={`${descriptionId}-identity`}
						className="flex min-w-0 flex-col"
					>
						<span
							className="truncate text-sm font-medium"
							title={name || document.filename}
						>
							{name || document.filename}
						</span>
						{subtitle && (
							<span
								className="truncate text-xs text-muted-foreground"
								title={subtitle}
							>
								{subtitle}
							</span>
						)}
					</span>
				</span>
				<span
					id={`${descriptionId}-extraction`}
					className={`col-start-1 row-start-2 flex items-center gap-1.5 text-xs sm:col-start-auto sm:row-start-auto ${attention || missing ? "font-medium text-warning-foreground" : "text-muted-foreground"}`}
				>
					<ExtractionIcon className="size-3.5 shrink-0" aria-hidden="true" />
					<span>
						<span>{documentLabel(document)}</span>
						{missing && <span className="block">Missing {missing}</span>}
					</span>
				</span>
				<span
					id={`${descriptionId}-review`}
					className="col-start-2 row-span-2 row-start-1 sm:col-start-auto sm:row-span-1 sm:row-start-auto"
				>
					{candidate && (
						<Badge
							variant={
								candidate.reviewState === "confirmed"
									? "success"
									: candidate.reviewState === "draft"
										? "outline"
										: "secondary"
							}
						>
							{reviewLabel[candidate.reviewState]}
						</Badge>
					)}
				</span>
				<ChevronRight
					aria-hidden="true"
					className="hidden size-4 text-muted-foreground group-hover:text-foreground sm:block"
				/>
			</button>
		</li>
	);
});

function sharePage(
	previous: QueuePage | undefined,
	next: QueuePage,
): QueuePage {
	if (!previous) return next;
	const byId = new Map(previous.items.map((item) => [item.document.id, item]));
	const items = next.items.map((item) => {
		const last = byId.get(item.document.id);
		// The API validates a page of at most 20 summaries without extracted text.
		return last && JSON.stringify(last) === JSON.stringify(item) ? last : item;
	});
	if (
		next.page === previous.page &&
		next.pageSize === previous.pageSize &&
		next.total === previous.total &&
		next.processing === previous.processing &&
		items.length === previous.items.length &&
		items.every((item, index) => item === previous.items[index])
	)
		return previous;
	return { ...next, items };
}

export const ReviewQueue = memo(function ReviewQueue({
	driveId,
	request,
	uploadRevision,
	onDirty,
	onOverviewChange,
}: {
	driveId: string;
	request: DriveRequest;
	uploadRevision: number;
	onDirty: (key: string, dirty: boolean) => void;
	onOverviewChange: () => void;
}) {
	const [query, setQuery] = useState({
		q: "",
		status: "all" as ReviewQueueStatus,
		page: 1,
	});
	const [revision, setRevision] = useState(0);
	const [result, setResult] = useState<{ key: string; data: QueuePage }>();
	const [error, setError] = useState("");
	const [selected, setSelected] = useState<{
		item: ReviewQueueItem;
		offset: number;
	}>();
	const trigger = useRef<HTMLElement | null>(null);
	const title = useRef<HTMLHeadingElement>(null);
	const search = useRef<HTMLInputElement>(null);
	const debounce = useRef<number>(undefined);
	const resultsPane = useRef<HTMLElement>(null);
	const processing = useRef<number | undefined>(undefined);
	const filterKey = `${query.status}:${query.q}`;
	const queryKey = `${query.page}:${filterKey}`;
	const data = result?.key === queryKey ? result.data : undefined;
	const displayed = result?.data;
	const resultKey = result?.key;
	const waiting = !data && !error;

	useEffect(() => () => window.clearTimeout(debounce.current), []);
	// biome-ignore lint/correctness/useExhaustiveDependencies: Reset only the results scroll when a different search or page arrives.
	useEffect(() => {
		resultsPane.current?.scrollTo(0, 0);
	}, [resultKey]);

	function scheduleSearch(value: string) {
		window.clearTimeout(debounce.current);
		const q = value.trim();
		debounce.current = window.setTimeout(() => {
			setQuery((current) =>
				current.q === q ? current : { ...current, q, page: 1 },
			);
		}, 250);
	}

	function clearFilters() {
		window.clearTimeout(debounce.current);
		if (search.current) {
			search.current.value = "";
			search.current.focus({ preventScroll: true });
		}
		setQuery({ q: "", status: "all", page: 1 });
	}

	const openCandidate = useCallback(
		(item: ReviewQueueItem, offset: number, element: HTMLButtonElement) => {
			trigger.current = element;
			setSelected({ item, offset });
		},
		[],
	);

	const readPage = useCallback(
		(page: number, signal?: AbortSignal) => {
			const params = new URLSearchParams({
				page: String(page),
				status: query.status,
				q: query.q,
			});
			return request(`/${driveId}/review-queue?${params}`, reviewQueueSchema, {
				signal,
			});
		},
		[driveId, query.q, query.status, request],
	);

	const acceptPage = useCallback(
		(next: QueuePage, requestedPage: number) => {
			const key = `${requestedPage}:${filterKey}`;
			setResult((current) => {
				const data = sharePage(current?.data, next);
				return current?.key === key && data === current.data
					? current
					: { key, data };
			});
			if (
				processing.current !== undefined &&
				processing.current !== next.processing
			)
				onOverviewChange();
			processing.current = next.processing;
			setError("");
		},
		[filterKey, onOverviewChange],
	);

	// biome-ignore lint/correctness/useExhaustiveDependencies: Upload and candidate mutations invalidate the currently displayed page.
	useEffect(() => {
		const controller = new AbortController();
		let timer: number;
		let delay = 1800;
		async function refresh() {
			try {
				const next = await readPage(query.page, controller.signal);
				if (controller.signal.aborted) return;
				acceptPage(next, query.page);
				if (!next.processing) return;
				delay = 1800;
			} catch (error) {
				if (controller.signal.aborted) return;
				setError(requestMessage(error));
				if (!processing.current) return;
				delay = Math.min(delay * 2, 15000);
			}
			timer = window.setTimeout(refresh, delay);
		}
		setError("");
		void refresh();
		return () => {
			controller.abort();
			window.clearTimeout(timer);
		};
	}, [acceptPage, query.page, readPage, revision, uploadRevision]);

	const index =
		displayed?.items.findIndex(
			(entry) => entry.document.id === selected?.item.document.id,
		) ?? -1;
	const item = displayed?.items[index] ?? selected?.item;
	const visibleStart = displayed
		? (displayed.page - 1) * displayed.pageSize
		: 0;
	const offset = index >= 0 ? visibleStart + index : (selected?.offset ?? 0);
	// If confirming a draft removes it from the active filter, the next match
	// moves into the same position, while the completed record stays open.
	const nextOffset = offset + (index >= 0 ? 1 : 0);
	async function move(direction: -1 | 1) {
		if (!data) return;
		const target =
			direction === 1 ? nextOffset : Math.min(offset, data.total) - 1;
		const targetPage = Math.floor(target / data.pageSize) + 1;
		const page = targetPage === data.page ? data : await readPage(targetPage);
		const local = Math.min(target % page.pageSize, page.items.length - 1);
		const row = page.items[local];
		if (page !== data) {
			acceptPage(page, targetPage);
			setQuery((current) => ({ ...current, page: targetPage }));
		}
		if (!row) return;
		setSelected({ item: row, offset: (page.page - 1) * page.pageSize + local });
	}
	const saved = useCallback(() => {
		setRevision((value) => value + 1);
		onOverviewChange();
	}, [onOverviewChange]);
	const filtered = query.q !== "" || query.status !== "all";

	return (
		<section
			aria-labelledby="candidate-review"
			className="flex min-w-0 flex-col gap-3"
		>
			<h2
				ref={title}
				tabIndex={-1}
				id="candidate-review"
				className="scroll-mt-6 text-2xl font-semibold outline-none"
			>
				Candidate review
			</h2>
			<div className="min-w-0 overflow-hidden rounded-lg border bg-card">
				<div className="flex flex-col gap-2 border-b p-3 sm:flex-row sm:items-center sm:justify-between sm:px-5">
					<div className="relative min-w-0 sm:w-80">
						<Search
							aria-hidden="true"
							className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
						/>
						<Input
							ref={search}
							type="search"
							aria-label="Search candidates"
							placeholder="Search name, email, or filename"
							maxLength={160}
							className="pl-9"
							onChange={(event) => scheduleSearch(event.currentTarget.value)}
						/>
					</div>
					<Select
						value={query.status}
						items={statusLabels}
						onValueChange={(value) => {
							if (value)
								setQuery((current) => ({ ...current, status: value, page: 1 }));
						}}
					>
						<SelectTrigger
							aria-label="Filter by status"
							className="w-full sm:w-44"
						>
							<ListFilter aria-hidden="true" />
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							{reviewQueueStatusSchema.options.map((value) => (
								<SelectItem key={value} value={value}>
									{statusLabels[value]}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				</div>
				<div
					aria-hidden="true"
					className="hidden grid-cols-[minmax(0,1fr)_10.75rem_6rem_1rem] gap-4 border-b bg-muted/45 px-5 py-2 text-xs font-medium text-muted-foreground sm:grid"
				>
					<span>Candidate / resume</span>
					<span>Extraction</span>
					<span>Review</span>
				</div>
				<section
					ref={resultsPane}
					aria-label="Candidate results"
					aria-busy={waiting}
					// biome-ignore lint/a11y/noNoninteractiveTabindex: Keyboard users need to focus this scroll pane.
					tabIndex={0}
					className="h-[clamp(13rem,36dvh,23rem)] overflow-y-auto overscroll-contain [scrollbar-gutter:stable] focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
				>
					{error && (
						<Alert variant="destructive" className="m-3 w-auto">
							<AlertTitle>{error}</AlertTitle>
							<Button
								size="sm"
								variant="outline"
								onClick={() => setRevision((value) => value + 1)}
							>
								Retry queue
							</Button>
						</Alert>
					)}
					{displayed && displayed.items.length > 0 && (
						<ul className="divide-y">
							{displayed.items.map((row, index) => (
								<QueueRow
									item={row}
									offset={visibleStart + index}
									key={row.document.id}
									onOpen={openCandidate}
								/>
							))}
						</ul>
					)}
					{data && data.items.length === 0 && !error && (
						<div className="flex h-full flex-col items-center justify-center gap-1 px-5 py-5 text-center">
							<Files
								aria-hidden="true"
								className="mb-1.5 size-5 text-muted-foreground"
							/>
							<p role="status" className="text-sm font-medium">
								{filtered ? "No matching resumes" : "No resumes yet"}
							</p>
							{filtered ? (
								<Button variant="link" size="sm" onClick={clearFilters}>
									Clear filters
								</Button>
							) : (
								<p className="text-xs text-muted-foreground">
									Upload resumes above to start reviewing candidates.
								</p>
							)}
						</div>
					)}
				</section>
				<div className="flex items-center justify-between gap-2 border-t px-3 py-1.5 sm:px-5">
					<p
						role="status"
						className="truncate text-xs text-muted-foreground tabular-nums"
					>
						{waiting
							? displayed
								? "Updating results…"
								: "Loading candidates…"
							: !data
								? displayed
									? "Showing previous results"
									: "Results unavailable"
								: data.total === 0
									? "0 resumes"
									: `${visibleStart + 1}–${visibleStart + data.items.length} of ${data.total} ${data.total === 1 ? "resume" : "resumes"}`}
					</p>
					<div className="flex items-center gap-1">
						<Button
							variant="ghost"
							size="icon-sm"
							aria-label="Previous page"
							disabled={!data || data.page <= 1}
							onClick={() =>
								data && setQuery({ ...query, page: data.page - 1 })
							}
						>
							<ChevronLeft />
						</Button>
						<Button
							variant="ghost"
							size="icon-sm"
							aria-label="Next page"
							disabled={!data || visibleStart + data.items.length >= data.total}
							onClick={() =>
								data && setQuery({ ...query, page: data.page + 1 })
							}
						>
							<ChevronRight />
						</Button>
					</div>
				</div>
			</div>
			<ReviewSheet
				outsidePage={index < 0}
				item={item}
				driveId={driveId}
				request={request}
				onDirty={onDirty}
				onSaved={saved}
				onClose={() => setSelected(undefined)}
				onMove={move}
				returnFocus={() =>
					trigger.current?.isConnected ? trigger.current : title.current
				}
				canPrevious={Boolean(data?.total && offset > 0)}
				canNext={Boolean(data && nextOffset < data.total)}
				position={
					data && index >= 0
						? `Resume ${offset + 1} of ${data.total}`
						: data
							? "Outside the current results"
							: "Loading queue…"
				}
			/>
		</section>
	);
});
