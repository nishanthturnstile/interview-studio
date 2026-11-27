import {
	type DirectorReportQuery,
	type DirectorResult,
	directorReportQuerySchema,
	directorReportSchema,
} from "@studio/contracts";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ChevronRight } from "lucide-react";
import { useRef, useState } from "react";
import type { z } from "zod";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
	Select,
	SelectContent,
	SelectGroup,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import {
	accessDenied,
	interviewRequest,
	retryInterviewRead,
} from "../interviews/api";
import {
	formatDate,
	InterviewAlert,
	InterviewLoading,
} from "../interviews/display";
import { decisionLabels } from "../interviews/scorecard";
import { DirectorScorecards } from "./director-scorecards";

const reportPath = "/staff/reports/interviews";
const statusLabels = {
	in_progress: "In progress",
	pending_review: "Pending HR review",
	selected: decisionLabels.selected,
	not_selected: decisionLabels.not_selected,
	do_not_proceed: decisionLabels.do_not_proceed,
	withdrawn: "Withdrawn",
} satisfies Record<DirectorResult["status"], string>;
const allDrives = { value: "", label: "All drives" };
const rounds = [
	{ value: "", label: "All rounds" },
	{ value: "l1", label: "L1" },
	{ value: "l2", label: "L2" },
];
const statuses = [
	{ value: "", label: "All outcomes" },
	...Object.entries(statusLabels).map(([value, label]) => ({ value, label })),
];
const decisions = ["selected", "not_selected", "do_not_proceed"] as const;
type Report = z.infer<typeof directorReportSchema>;

function ReportSelect({
	label,
	items,
	value,
	onChange,
}: {
	label: string;
	items: { value: string; label: string }[];
	value: string;
	onChange: (value: string) => void;
}) {
	return (
		<div className="flex min-w-0 flex-col gap-1.5">
			<p className="text-sm font-medium">{label}</p>
			<Select
				items={items}
				value={value}
				onValueChange={(value) => onChange(value ?? "")}
			>
				<SelectTrigger aria-label={label} className="h-9 w-full min-w-0">
					<SelectValue className="min-w-0 truncate" />
				</SelectTrigger>
				<SelectContent>
					<SelectGroup>
						{items.map((item) => (
							<SelectItem key={item.value} value={item.value}>
								{item.label}
							</SelectItem>
						))}
					</SelectGroup>
				</SelectContent>
			</Select>
		</div>
	);
}

function DriveProgress({ progress }: Pick<Report, "progress">) {
	const rows = progress.map(({ drive, counts }) => {
		const final = decisions.reduce((sum, status) => sum + counts[status], 0);
		const segments = [
			{
				label: "in progress",
				color: "bg-info-foreground",
				count: counts.in_progress,
			},
			{
				label: final === 1 ? "final decision" : "final decisions",
				color: "bg-success-foreground",
				count: final,
			},
			{
				label: "pending HR review",
				color: "bg-warning-foreground",
				count: counts.pending_review,
			},
		];
		return {
			drive,
			segments,
			total: segments.reduce((sum, { count }) => sum + count, 0),
		};
	});
	const max = rows.reduce((largest, { total }) => Math.max(largest, total), 1);
	return (
		<section
			aria-labelledby="drive-progress"
			className="min-w-0 rounded-xl border bg-card p-4 sm:p-5"
		>
			<h2 id="drive-progress" className="text-base font-semibold">
				Drive progress
			</h2>
			{rows.length ? (
				<ul className="mt-3 space-y-4">
					{rows.map(({ drive, segments, total }) => (
						<li key={drive.id}>
							<div className="mb-1.5 flex justify-between gap-3 text-sm">
								<span className="min-w-0 font-medium [overflow-wrap:anywhere]">
									{drive.title}
								</span>
								<span
									aria-hidden="true"
									className="shrink-0 text-muted-foreground tabular-nums"
								>
									{total}
								</span>
							</div>
							<div
								aria-hidden="true"
								className="flex h-3.5 overflow-hidden rounded-sm bg-muted"
							>
								{segments.map(({ label, color, count }) => (
									<div
										key={label}
										className={color}
										style={{ width: `${(count / max) * 100}%` }}
									/>
								))}
							</div>
							<ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1.5 text-xs text-muted-foreground">
								{segments.map(({ label, color, count }) => (
									<li key={label} className="flex items-center gap-1.5">
										<span
											aria-hidden="true"
											className={`size-2 rounded-sm ${color}`}
										/>
										<span>
											<span className="font-medium text-foreground tabular-nums">
												{count}
											</span>{" "}
											{label}
										</span>
									</li>
								))}
							</ul>
						</li>
					))}
				</ul>
			) : (
				<p className="mt-5 text-sm text-muted-foreground">
					No matching candidacies.
				</p>
			)}
		</section>
	);
}

function DecisionSummary({ report }: { report: Report }) {
	return (
		<section
			aria-labelledby="director-outcomes"
			className="min-w-0 rounded-xl border bg-card p-4 sm:p-5"
		>
			<h2 id="director-outcomes" className="text-base font-semibold">
				Final outcomes
			</h2>
			<dl className="mt-3 grid grid-cols-3 gap-3">
				{decisions.map((status) => (
					<div key={status} className="min-w-0">
						<dt className="text-sm text-muted-foreground">
							{statusLabels[status]}
						</dt>
						<dd
							className={`text-2xl font-semibold tracking-tight tabular-nums ${status === "selected" ? "text-success-foreground" : ""}`}
						>
							{report.totals[status]}
						</dd>
					</div>
				))}
			</dl>
			<div className="mt-4 space-y-1 border-t pt-3 text-xs text-muted-foreground">
				<p>{report.totals.withdrawn} withdrawn</p>
				<p>
					{report.cancelled} cancelled{" "}
					{report.cancelled === 1 ? "attempt" : "attempts"} · {report.noShows}{" "}
					no-show {report.noShows === 1 ? "attempt" : "attempts"}
				</p>
				<p>Attempt counts use the attempt’s round and date.</p>
			</div>
		</section>
	);
}

function CandidateResults({
	report,
	onView,
	onPage,
	paging,
}: {
	report: Report;
	onView: (item: DirectorResult, opener: HTMLButtonElement) => void;
	onPage: (page: number) => void;
	paging: boolean;
}) {
	const total = Object.values(report.totals).reduce(
		(sum, count) => sum + count,
		0,
	);
	const { items, page, pageSize } = report;
	const previousDisabled = page === 1 || paging;
	const nextDisabled = page * pageSize >= total || paging;
	return (
		<section
			aria-labelledby="director-results"
			aria-busy={paging}
			className="min-w-0 rounded-xl border bg-card"
		>
			<header className="flex items-center justify-between gap-3 border-b px-4 py-3 sm:px-5">
				<h2 id="director-results" className="text-base font-semibold">
					Candidate results
				</h2>
				<span className="text-sm text-muted-foreground tabular-nums">
					{total} {total === 1 ? "candidacy" : "candidacies"}
				</span>
			</header>
			{items.length ? (
				<ul className="divide-y">
					{items.map((item) => (
						<li
							key={`${item.drive.id}/${item.id}`}
							className="grid min-w-0 gap-x-4 gap-y-2 px-4 py-3 sm:px-5 @min-[39rem]/director:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_8.5rem_8.5rem] @min-[39rem]/director:items-center"
						>
							<p className="min-w-0 text-sm font-semibold [overflow-wrap:anywhere]">
								{item.name}
							</p>
							<div className="min-w-0 text-sm [overflow-wrap:anywhere]">
								<p>
									{item.drive.title}
									{item.round && ` · ${item.round.toUpperCase()}`}
								</p>
								<time
									dateTime={item.activityDate}
									className="text-xs text-muted-foreground"
								>
									{formatDate(item.activityDate, "UTC")}
								</time>
							</div>
							<Badge
								variant={
									item.status === "selected"
										? "success"
										: item.status === "pending_review"
											? "warning"
											: item.status === "in_progress"
												? "info"
												: "muted"
								}
							>
								{statusLabels[item.status]}
							</Badge>
							{item.hasScorecards && (
								<Button
									type="button"
									variant="ghost"
									size="sm"
									className="-ml-2 w-fit @min-[39rem]/director:ml-auto"
									aria-label={`View scorecards for ${item.name}`}
									onClick={(event) => onView(item, event.currentTarget)}
								>
									View scorecards <ChevronRight aria-hidden="true" />
								</Button>
							)}
						</li>
					))}
				</ul>
			) : (
				<p className="px-4 py-5 text-sm text-muted-foreground sm:px-5">
					{page > 1
						? "No results on this page."
						: "No candidacies match these filters."}
				</p>
			)}
			{(page > 1 || total > pageSize) && (
				<nav
					aria-label="Candidate results pages"
					className="flex items-center justify-end gap-3 border-t px-4 py-3 text-sm sm:px-5"
				>
					<Button
						variant="outline"
						size="sm"
						aria-disabled={previousDisabled}
						className="aria-disabled:opacity-50"
						onClick={() => {
							if (!previousDisabled) onPage(page - 1);
						}}
					>
						Previous
					</Button>
					<span aria-live="polite">Page {page}</span>
					<Button
						variant="outline"
						size="sm"
						aria-disabled={nextDisabled}
						className="aria-disabled:opacity-50"
						onClick={() => {
							if (!nextDisabled) onPage(page + 1);
						}}
					>
						Next
					</Button>
				</nav>
			)}
		</section>
	);
}

export function DirectorDashboard() {
	const [filters, setFilters] = useState({
		driveId: "",
		round: "",
		outcome: "",
		from: "",
		to: "",
	});
	const [page, setPage] = useState(1);
	const [selected, setSelected] = useState<DirectorResult>();
	const opener = useRef<HTMLButtonElement>(null);
	const heading = useRef<HTMLHeadingElement>(null);
	const params = new URLSearchParams();
	for (const [key, value] of Object.entries(filters)) {
		if (value) params.set(key, value);
	}
	const scope = params.toString();
	params.set("page", String(page));
	const valid = directorReportQuerySchema.safeParse(Object.fromEntries(params));
	const request = useQuery({
		queryKey: ["director-report", params.toString()],
		queryFn: async ({ signal }) => ({
			scope,
			report: await interviewRequest(
				`${reportPath}?${params}`,
				directorReportSchema,
				{
					signal,
				},
			),
		}),
		enabled: valid.success,
		placeholderData: keepPreviousData,
		refetchOnWindowFocus: "always",
		retry: retryInterviewRead,
	});
	const denied = accessDenied(request.error);
	const data = denied ? undefined : request.data;
	const report =
		valid.success && data?.scope === scope ? data.report : undefined;
	const driveOptions = [
		allDrives,
		...(data?.report.drives.map(({ id, title }) => ({
			value: id,
			label: title,
		})) ?? []),
	];

	function update(
		field: keyof Omit<DirectorReportQuery, "page">,
		value: string,
	) {
		setFilters((previous) => ({ ...previous, [field]: value }));
		setPage(1);
	}

	return (
		<section className="@container/director mx-auto flex w-full max-w-6xl min-w-0 flex-col gap-5 px-4 py-8 sm:px-8 sm:py-10">
			<header className="flex flex-wrap items-center justify-between gap-3">
				<div>
					<h1
						ref={heading}
						tabIndex={-1}
						className="text-3xl leading-tight font-bold tracking-tight"
					>
						Director dashboard
					</h1>
					<p className="mt-1 text-sm text-muted-foreground">
						Interview progress and outcomes across drives
					</p>
				</div>
				<Link
					to="/staff/access"
					className={buttonVariants({ variant: "outline" })}
				>
					Manage staff access
				</Link>
			</header>
			{!denied && (
				<section
					aria-label="Report filters"
					className="space-y-3 rounded-xl border bg-card p-4 sm:p-5"
				>
					<div className="grid items-end gap-3 @min-[30rem]/director:grid-cols-2 @min-[53rem]/director:grid-cols-[minmax(0,1fr)_minmax(0,1.8fr)_minmax(0,0.72fr)_minmax(0,1.05fr)]">
						<ReportSelect
							label="Drive"
							items={driveOptions}
							value={filters.driveId}
							onChange={(value) => update("driveId", value)}
						/>
						<fieldset className="min-w-0">
							<legend className="float-left mb-1.5 w-full text-sm font-medium">
								Latest activity (UTC)
							</legend>
							<div className="clear-both grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-1.5">
								<Input
									type="date"
									aria-label="From date"
									aria-invalid={!valid.success}
									className="h-9 min-w-0"
									value={filters.from}
									onChange={(event) => update("from", event.target.value)}
								/>
								<span aria-hidden="true" className="text-muted-foreground">
									–
								</span>
								<Input
									type="date"
									aria-label="To date"
									aria-invalid={!valid.success}
									className="h-9 min-w-0"
									value={filters.to}
									onChange={(event) => update("to", event.target.value)}
								/>
							</div>
						</fieldset>
						<ReportSelect
							label="Current round"
							items={rounds}
							value={filters.round}
							onChange={(value) => update("round", value)}
						/>
						<ReportSelect
							label="Outcome"
							items={statuses}
							value={filters.outcome}
							onChange={(value) => update("outcome", value)}
						/>
					</div>
					{Object.values(filters).some(Boolean) && (
						<Button
							variant="ghost"
							size="sm"
							className="-ml-2 w-fit"
							onClick={() => {
								setFilters({
									driveId: "",
									round: "",
									outcome: "",
									from: "",
									to: "",
								});
								setPage(1);
							}}
						>
							Clear filters
						</Button>
					)}
				</section>
			)}
			{!valid.success && (
				<p role="alert" className="text-sm text-error-foreground">
					Enter a valid date range with the start on or before the end.
				</p>
			)}
			{request.error && (
				<div className="flex flex-wrap items-center gap-2">
					<InterviewAlert error={request.error} />
					{!denied && (
						<Button
							variant="outline"
							size="sm"
							onClick={() => void request.refetch()}
						>
							Try again
						</Button>
					)}
				</div>
			)}
			{!report &&
				valid.success &&
				(request.isPending || request.isPlaceholderData) && (
					<InterviewLoading />
				)}
			{report && (
				<>
					<div className="grid gap-4 @min-[42rem]/director:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
						<DriveProgress progress={report.progress} />
						<DecisionSummary report={report} />
					</div>
					<CandidateResults
						report={report}
						paging={request.isPlaceholderData}
						onPage={setPage}
						onView={(item, button) => {
							opener.current = button;
							setSelected(item);
						}}
					/>
				</>
			)}
			<Sheet
				open={Boolean(selected) && !denied}
				onOpenChange={(open) => {
					if (!open) setSelected(undefined);
				}}
			>
				<SheetContent
					className="gap-0 bg-card data-[side=right]:w-full data-[side=right]:sm:max-w-[34rem]"
					finalFocus={() =>
						opener.current?.isConnected ? opener.current : heading.current
					}
				>
					{selected && (
						<DirectorScorecards
							key={`${selected.drive.id}/${selected.id}`}
							candidacy={selected}
							path={reportPath}
						/>
					)}
				</SheetContent>
			</Sheet>
		</section>
	);
}
