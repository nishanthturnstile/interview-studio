import {
	canManageInterviews,
	type EligibleInterviewCandidate,
	type InterviewWorkspaceItem,
	type InterviewWorkspaceQuery,
	interviewWorkspaceQuerySchema,
	roundSchema,
} from "@studio/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getRouteApi, Link, useBlocker } from "@tanstack/react-router";
import {
	CalendarDays,
	ChevronDown,
	ChevronLeft,
	ChevronRight,
	RefreshCw,
	Search,
	SlidersHorizontal,
} from "lucide-react";
import { type FormEvent, useEffect, useId, useRef, useState } from "react";
import { Alert, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
	InputGroup,
	InputGroupAddon,
	InputGroupInput,
} from "@/components/ui/input-group";
import {
	Select,
	SelectContent,
	SelectGroup,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { accessDenied } from "./api";
import {
	experienceLabel,
	formatClock,
	formatDate,
	InterviewAlert,
	InterviewEmpty,
	InterviewLoading,
	InterviewStatus,
	scheduleLabel,
	workspaceActionLabels,
} from "./display";
import { FeedbackReviewInbox, FeedbackReviewSheet } from "./feedback-reviews";
import {
	BookingSheet,
	HrRoundDetail,
	WithdrawCandidacySheet,
} from "./hr-actions";
import {
	feedbackReviewKey,
	hrInterviewsQuery,
	invalidateHrInterviews,
} from "./hr-queries";
import { CandidacyTimeline } from "./hr-timeline";
import { decisionLabels } from "./scorecard";

const staffRoute = getRouteApi("/staff");
const route = getRouteApi("/staff/interviews");
const tabs = [
	{ id: "queue", label: "Action needed" },
	{ id: "scheduled", label: "Scheduled" },
	{ id: "awaiting", label: "Awaiting feedback" },
	{ id: "history", label: "History" },
] as const;
const emptyCopy = {
	queue: [
		"No HR actions needed",
		"Scheduling and feedback issues that need your attention appear here.",
	],
	scheduled: [
		"No scheduled interviews",
		"Upcoming and live interviews appear here.",
	],
	awaiting: [
		"No interviews awaiting feedback",
		"Interviews appear here while the panelist completes their scorecard.",
	],
	history: [
		"No closed candidacies",
		"Final outcomes and their interview history appear here.",
	],
};

type Range = { minYears?: string; maxYears?: string };

const roundFilters = [
	{ value: "all", label: "All rounds" },
	{ value: "l1", label: "L1" },
	{ value: "l2", label: "L2" },
];

function ExperienceFilter({
	range,
	onApply,
}: {
	range: Range;
	onApply: (range: Range) => void;
}) {
	const [open, setOpen] = useState(false);
	const trigger = useRef<HTMLButtonElement>(null);
	const [draft, setDraft] = useState(range);
	const [error, setError] = useState(false);
	const { minYears, maxYears } = range;
	useEffect(() => {
		setDraft({ minYears, maxYears });
		setError(false);
	}, [minYears, maxYears]);
	const active = range.minYears !== undefined || range.maxYears !== undefined;
	const summary =
		range.minYears !== undefined && range.maxYears !== undefined
			? `${range.minYears}–${range.maxYears} years`
			: range.minYears !== undefined
				? `${range.minYears}+ years`
				: `Up to ${range.maxYears} years`;

	function apply(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		const result = interviewWorkspaceQuerySchema.safeParse(draft);
		if (!result.success) {
			setError(true);
			return;
		}
		const { minYears, maxYears } = result.data;
		onApply({ minYears: minYears?.toString(), maxYears: maxYears?.toString() });
		setOpen(false);
		trigger.current?.focus();
	}

	return (
		<Collapsible
			className="contents"
			open={open}
			onOpenChange={(next) => {
				if (next) {
					setDraft(range);
					setError(false);
				}
				setOpen(next);
			}}
		>
			<CollapsibleTrigger
				ref={trigger}
				render={
					<Button
						variant={active ? "secondary" : "outline"}
						className="group col-span-full h-10 min-w-0 justify-start px-3 md:col-span-1"
					/>
				}
				aria-label={active ? `Experience, ${summary}` : "Experience"}
			>
				<SlidersHorizontal data-icon="inline-start" />
				<span className="truncate">{active ? summary : "Experience"}</span>
				<ChevronDown
					data-icon="inline-end"
					className="ml-auto group-aria-expanded:rotate-180"
				/>
			</CollapsibleTrigger>
			<CollapsibleContent className="col-span-full border-t pt-3">
				<form
					onSubmit={apply}
					aria-label="Experience range"
					className="flex flex-col gap-3"
				>
					<FieldGroup className="grid grid-cols-2 gap-3 sm:max-w-sm">
						<Field>
							<FieldLabel htmlFor="interview-min">Minimum years</FieldLabel>
							<Input
								id="interview-min"
								type="number"
								min={0}
								max={80}
								step={0.1}
								value={draft.minYears ?? ""}
								aria-invalid={error}
								onChange={(event) => {
									setDraft({
										...draft,
										minYears: event.target.value || undefined,
									});
									setError(false);
								}}
							/>
						</Field>
						<Field>
							<FieldLabel htmlFor="interview-max">Maximum years</FieldLabel>
							<Input
								id="interview-max"
								type="number"
								min={0}
								max={80}
								step={0.1}
								value={draft.maxYears ?? ""}
								aria-invalid={error}
								onChange={(event) => {
									setDraft({
										...draft,
										maxYears: event.target.value || undefined,
									});
									setError(false);
								}}
							/>
						</Field>
					</FieldGroup>
					{error && (
						<p role="alert" className="text-sm text-destructive">
							Enter a range from 0 to 80 years with the minimum at or below the
							maximum.
						</p>
					)}
					<div className="flex flex-wrap gap-2">
						<Button type="submit" size="sm">
							Apply experience
						</Button>
						{(active ||
							draft.minYears !== undefined ||
							draft.maxYears !== undefined) && (
							<Button
								type="button"
								variant="ghost"
								size="sm"
								onClick={() => {
									onApply({ minYears: undefined, maxYears: undefined });
									setOpen(false);
									trigger.current?.focus();
								}}
							>
								Clear experience
							</Button>
						)}
					</div>
				</form>
			</CollapsibleContent>
		</Collapsible>
	);
}

const rowLayout =
	"grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-2 px-4 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_9rem] sm:gap-x-5 sm:px-5";

function QueueRow({
	item,
	disabled,
	onOpen,
	onL1,
	onHistory,
}: {
	item: EligibleInterviewCandidate;
	disabled: boolean;
	onOpen: (item: EligibleInterviewCandidate, button: HTMLButtonElement) => void;
	onL1: (id: string, button: HTMLButtonElement) => void;
	onHistory?: (button: HTMLButtonElement) => void;
}) {
	const label = `Schedule ${item.level.toUpperCase()}`;
	const l1RoundId = item.qualifyingL1RoundId;
	return (
		<li className={`grid ${rowLayout} py-3.5`}>
			<div className="min-w-0 [overflow-wrap:anywhere]">
				{onHistory ? (
					<button
						type="button"
						className="max-w-full text-left font-semibold underline-offset-4 hover:underline"
						disabled={disabled}
						aria-label={`View interview timeline for ${item.name}`}
						onClick={(event) => onHistory(event.currentTarget)}
					>
						{item.name}
					</button>
				) : (
					<p className="font-semibold">{item.name}</p>
				)}
				<p className="mt-0.5 text-sm text-muted-foreground">{item.email}</p>
			</div>
			<div className="col-start-1 row-start-2 min-w-0 text-sm [overflow-wrap:anywhere] sm:col-start-auto sm:row-start-auto">
				<p className="font-medium">
					{item.level === "l2" ? "L1 passed" : "Ready for L1"} ·{" "}
					{item.drive.title}
				</p>
				<p className="mt-0.5 text-muted-foreground">
					{experienceLabel(item.years)}
				</p>
				{item.lastAttempt > 0 && (
					<p className="text-muted-foreground">
						Rebook · Attempt {item.lastAttempt + 1}
					</p>
				)}
			</div>
			<div className="col-start-2 row-span-2 row-start-1 flex flex-col items-end gap-1 sm:col-start-auto sm:row-span-1 sm:row-start-auto">
				<Button
					variant="outline"
					size="sm"
					disabled={disabled}
					aria-label={`${label} for ${item.name}`}
					onClick={(event) => onOpen(item, event.currentTarget)}
				>
					<CalendarDays data-icon="inline-start" />
					{label}
				</Button>
				{l1RoundId && (
					<Button
						variant="ghost"
						size="sm"
						disabled={disabled}
						onClick={(event) => onL1(l1RoundId, event.currentTarget)}
					>
						View L1 scorecard
					</Button>
				)}
			</div>
		</li>
	);
}

function WorkspaceRow({
	item,
	tab,
	disabled,
	onBooking,
	onReview,
	onHistory,
	onWithdraw,
}: {
	item: InterviewWorkspaceItem;
	tab: InterviewWorkspaceQuery["tab"];
	disabled: boolean;
	onBooking: (id: string, button: HTMLButtonElement) => void;
	onReview: (id: string, button: HTMLButtonElement) => void;
	onHistory: (item: InterviewWorkspaceItem, button: HTMLButtonElement) => void;
	onWithdraw: (
		item: EligibleInterviewCandidate,
		button: HTMLButtonElement,
	) => void;
}) {
	const { round, l1RoundId, reviewId, outcome } = item;
	const labels = workspaceActionLabels(item);
	const primary =
		tab === "history"
			? "View interview history"
			: (labels?.action ?? "View booking");
	const buttonClass = "h-auto min-h-10 max-w-full whitespace-normal";
	return (
		<li className={`grid ${rowLayout} py-3.5`}>
			<div className="min-w-0 [overflow-wrap:anywhere]">
				{tab !== "history" && item.hasAttempts ? (
					<button
						type="button"
						className="max-w-full text-left font-semibold underline-offset-4 hover:underline"
						disabled={disabled}
						aria-label={`View interview timeline for ${item.name}`}
						onClick={(event) => onHistory(item, event.currentTarget)}
					>
						{item.name}
					</button>
				) : (
					<p className="font-semibold">{item.name}</p>
				)}
				<p className="mt-0.5 text-sm text-muted-foreground">
					{item.drive.title}
					{round &&
						` · ${round.level.toUpperCase()} · Attempt ${round.attempt}`}
				</p>
			</div>
			<div className="col-start-1 row-start-2 min-w-0 text-sm [overflow-wrap:anywhere] sm:col-start-auto sm:row-start-auto">
				{labels && (
					<p className="font-medium text-warning-foreground">{labels.status}</p>
				)}
				{round && (
					<>
						<p className="tabular-nums">
							{tab === "awaiting" && round.closedAt
								? `Ended ${formatDate(round.closedAt, round.timeZone)}, ${formatClock(round.closedAt, round.timeZone)} (${round.timeZone})`
								: scheduleLabel(round.start, round.end, round.timeZone)}
						</p>
						<p className="mt-0.5 text-muted-foreground">
							{round.panelist.name}
							{tab === "scheduled" &&
								round.meeting.mode === "virtual" &&
								!round.meeting.teamsUrl &&
								" · Meeting link pending"}
						</p>
					</>
				)}
				{tab === "history" && outcome && (
					<Badge variant={outcome === "selected" ? "success" : "muted"}>
						{outcome === "withdrawn" ? "Withdrawn" : decisionLabels[outcome]}
					</Badge>
				)}
			</div>
			<div className="col-start-2 row-span-2 row-start-1 flex flex-col items-end gap-1 sm:col-start-auto sm:row-span-1 sm:row-start-auto">
				{round && tab !== "queue" && <InterviewStatus state={round.state} />}
				{item.action === "review_skills" && !disabled ? (
					<Link
						to="/staff/drives/$driveId"
						params={{ driveId: item.drive.id }}
						hash="scorecard-skills"
						className={buttonVariants({ variant: "outline", size: "sm" })}
					>
						Review skills
					</Link>
				) : (
					<Button
						variant={tab === "queue" ? "outline" : "ghost"}
						size="sm"
						className={buttonClass}
						disabled={disabled}
						aria-label={`${primary} for ${item.name}`}
						onClick={(event) => {
							if (tab === "history") onHistory(item, event.currentTarget);
							else if (reviewId) onReview(reviewId, event.currentTarget);
							else if (round) onBooking(round.id, event.currentTarget);
						}}
					>
						{primary}{" "}
						{tab !== "queue" && <ChevronRight data-icon="inline-end" />}
					</Button>
				)}
				{tab !== "history" &&
					l1RoundId &&
					item.action !== "review_feedback" &&
					round?.id !== l1RoundId && (
						<Button
							variant="ghost"
							size="sm"
							className={buttonClass}
							disabled={disabled}
							onClick={(event) => onBooking(l1RoundId, event.currentTarget)}
						>
							View L1 scorecard
						</Button>
					)}
				{item.action === "review_skills" && item.eligible && (
					<Button
						variant="ghost"
						size="sm"
						className={buttonClass}
						disabled={disabled}
						aria-label={`Withdraw candidacy for ${item.name}`}
						onClick={(event) => {
							if (item.eligible) onWithdraw(item.eligible, event.currentTarget);
						}}
					>
						Withdraw candidacy
					</Button>
				)}
			</div>
		</li>
	);
}

export function Interviews() {
	const viewer = staffRoute.useLoaderData();
	const search = route.useSearch();
	const navigate = route.useNavigate();
	const client = useQueryClient();
	const allowed = canManageInterviews(viewer.role);
	const tab = search.tab ?? "queue";
	const reviewId = search.review;
	const page = search.page ?? 1;
	const urlSearch = search.search ?? "";
	const [searchText, setSearchText] = useState(urlSearch);
	const searchTimer = useRef<number>(undefined);
	useEffect(() => {
		setSearchText(urlSearch);
	}, [urlSearch]);
	useEffect(() => () => window.clearTimeout(searchTimer.current), []);
	const range = { minYears: search.minYears, maxYears: search.maxYears };
	const parsed = interviewWorkspaceQuerySchema.safeParse({
		tab,
		page,
		search: urlSearch,
		driveId: search.driveId,
		level: search.level,
		...range,
	});
	const request = useQuery({
		...hrInterviewsQuery(parsed.data ?? { tab, page, search: "" }),
		enabled: allowed && parsed.success,
		placeholderData: (previous) => previous,
	});
	const [candidate, setCandidate] = useState<EligibleInterviewCandidate>();
	const [withdrawal, setWithdrawal] = useState<EligibleInterviewCandidate>();
	const [timeline, setTimeline] = useState<InterviewWorkspaceItem>();
	const [updatesPage, setUpdatesPage] = useState(1);
	const [notice, setNotice] = useState("");
	const [saving, setSaving] = useState(false);
	useBlocker({
		shouldBlockFn: () => saving,
		enableBeforeUnload: saving,
	});
	const searchInput = useRef<HTMLInputElement>(null);
	const opener = useRef<HTMLButtonElement>(null);
	const denied = accessDenied(request.error);
	const actionTab = useRef<HTMLButtonElement>(null);
	const actionCountId = useId();

	function setSearch(fields: Partial<typeof search>, replace = true) {
		void navigate({
			search: (previous) => ({ ...previous, ...fields }),
			replace,
		});
	}
	function applyFilters(fields: Partial<typeof search>, replace = true) {
		window.clearTimeout(searchTimer.current);
		setSearch(
			{ search: searchText || undefined, page: undefined, ...fields },
			replace,
		);
	}

	if (!allowed)
		return (
			<section className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-8">
				<h1 className="mb-4 text-3xl font-bold">Interviews</h1>
				<InterviewEmpty
					title="Interviews is available to HR"
					description="Open the workspace linked to your staff role."
				/>
			</section>
		);

	const data =
		!denied && parsed.success && request.data?.tab === tab
			? request.data
			: undefined;
	const drives = [
		{ value: "all", label: "All drives" },
		...(!denied ? (request.data?.drives ?? []) : []).map((drive) => ({
			value: drive.id,
			label: drive.title,
		})),
	];
	const filtered = Boolean(
		searchText ||
			search.driveId ||
			search.level ||
			range.minYears !== undefined ||
			range.maxYears !== undefined,
	);
	const pageCount = data
		? Math.max(1, Math.ceil(data.total / data.pageSize))
		: 1;
	const changingFilters = request.isPlaceholderData || searchText !== urlSearch;
	const empty = filtered
		? [
				"No matches",
				"Try changing your search, drive, round, or experience range.",
			]
		: emptyCopy[tab];

	function openCandidate(
		item: EligibleInterviewCandidate,
		button: HTMLButtonElement,
	) {
		opener.current = button;
		setCandidate(item);
	}

	function openBooking(booking: string, button: HTMLButtonElement) {
		opener.current = button;
		setSearch({ booking, version: undefined, review: undefined });
	}
	function openReview(review: string, button: HTMLButtonElement) {
		opener.current = button;
		setSearch({ review, booking: undefined, version: undefined });
	}
	function openTimeline(
		item: InterviewWorkspaceItem,
		button: HTMLButtonElement,
	) {
		opener.current = button;
		setTimeline(item);
	}
	function openWithdrawal(
		item: EligibleInterviewCandidate,
		button: HTMLButtonElement,
	) {
		opener.current = button;
		setWithdrawal(item);
	}
	function onWithdrawn() {
		setCandidate(undefined);
		setWithdrawal(undefined);
		setNotice("Candidate withdrawn.");
		void invalidateHrInterviews(client);
	}

	return (
		<section className="mx-auto flex w-full max-w-6xl flex-col gap-5 px-4 py-8 sm:px-8 sm:py-10">
			<header>
				<h1 className="text-3xl leading-tight font-bold tracking-tight">
					Interviews
				</h1>
				<p className="mt-1.5 text-sm text-muted-foreground">
					See what needs your attention and follow each candidate through their
					interviews.
				</p>
			</header>
			<Tabs
				className="min-w-0 gap-4"
				value={tab}
				onValueChange={(next) => {
					const target = tabs.find(({ id }) => id === next);
					if (target && target.id !== tab) {
						setNotice("");
						applyFilters(
							{
								tab: target.id,
								booking: undefined,
								review: undefined,
								version: undefined,
							},
							false,
						);
					}
				}}
			>
				<div className="overflow-hidden rounded-lg border bg-card">
					<div className="flex items-center gap-2 border-b px-3 sm:px-4">
						<div className="min-w-0 flex-1">
							<TabsList
								variant="line"
								className="grid h-auto! w-full grid-cols-2 gap-1 lg:flex lg:h-12! lg:w-max lg:justify-start lg:gap-3"
							>
								{tabs.map(({ id, label }) => (
									<TabsTrigger
										className="h-10 after:bottom-0 sm:h-full sm:after:bottom-[-3px]"
										key={id}
										value={id}
										ref={id === "queue" ? actionTab : undefined}
										aria-describedby={
											id === "queue" && request.data && !denied
												? actionCountId
												: undefined
										}
									>
										{label}
										{id === "queue" && request.data && !denied && (
											<Badge
												id={actionCountId}
												variant={request.data.actionTotal ? "warning" : "muted"}
												aria-hidden="true"
											>
												{request.data.actionTotal}
											</Badge>
										)}
									</TabsTrigger>
								))}
							</TabsList>
						</div>
						<Button
							variant="ghost"
							size="icon-sm"
							className="shrink-0"
							title="Refresh interviews"
							aria-label="Refresh interviews"
							disabled={
								request.isFetching || changingFilters || !parsed.success
							}
							onClick={() => {
								void request.refetch();
								void client.invalidateQueries({ queryKey: feedbackReviewKey });
							}}
						>
							<RefreshCw
								className={
									request.isFetching ? "motion-safe:animate-spin" : undefined
								}
							/>
						</Button>
					</div>
					<FieldGroup className="grid grid-cols-2 items-start gap-2.5 p-3 md:grid-cols-[minmax(0,1.8fr)_minmax(9rem,1fr)_minmax(7rem,auto)_minmax(8.5rem,auto)] sm:p-4">
						<Field className="col-span-full md:col-span-1">
							<FieldLabel htmlFor="interview-search" className="sr-only">
								Candidate
							</FieldLabel>
							<InputGroup className="h-10">
								<InputGroupAddon>
									<Search aria-hidden="true" />
								</InputGroupAddon>
								<InputGroupInput
									id="interview-search"
									ref={searchInput}
									type="search"
									maxLength={120}
									placeholder="Search by name or email"
									value={searchText}
									onChange={(event) => {
										const value = event.target.value;
										setSearchText(value);
										window.clearTimeout(searchTimer.current);
										searchTimer.current = window.setTimeout(
											() =>
												setSearch({
													search: value || undefined,
													page: undefined,
												}),
											250,
										);
									}}
								/>
							</InputGroup>
						</Field>
						<Field className="min-w-0">
							<FieldLabel htmlFor="interview-drive" className="sr-only">
								Drive
							</FieldLabel>
							<Select
								items={drives}
								value={search.driveId ?? "all"}
								onValueChange={(value) =>
									applyFilters({
										driveId: value === "all" ? undefined : (value ?? undefined),
									})
								}
							>
								<SelectTrigger id="interview-drive" className="w-full">
									<SelectValue placeholder="All drives" />
								</SelectTrigger>
								<SelectContent>
									<SelectGroup>
										{drives.map((drive) => (
											<SelectItem key={drive.value} value={drive.value}>
												{drive.label}
											</SelectItem>
										))}
									</SelectGroup>
								</SelectContent>
							</Select>
						</Field>
						<Field className="min-w-0">
							<FieldLabel htmlFor="interview-round" className="sr-only">
								Round
							</FieldLabel>
							<Select
								items={roundFilters}
								value={search.level ?? "all"}
								onValueChange={(value) =>
									applyFilters({ level: roundSchema.safeParse(value).data })
								}
							>
								<SelectTrigger id="interview-round" className="w-full">
									<SelectValue placeholder="All rounds" />
								</SelectTrigger>
								<SelectContent>
									<SelectGroup>
										{roundFilters.map(({ value, label }) => (
											<SelectItem value={value} key={value}>
												{label}
											</SelectItem>
										))}
									</SelectGroup>
								</SelectContent>
							</Select>
						</Field>
						<ExperienceFilter
							range={range}
							onApply={(next) => applyFilters(next)}
						/>
					</FieldGroup>
				</div>
				{notice && (
					<Alert role="status" variant="success">
						<AlertTitle>{notice}</AlertTitle>
					</Alert>
				)}
				{tabs.map(({ id }) => (
					<TabsContent
						key={id}
						value={id}
						aria-busy={
							id === tab &&
							(request.isPending || changingFilters) &&
							parsed.success
						}
					>
						{id === tab && (
							<div className="flex flex-col gap-2.5">
								<div className="flex min-h-9 items-center justify-between gap-2 px-0.5 text-sm">
									<p
										role="status"
										className="font-medium text-muted-foreground"
									>
										{data
											? `${data.total} ${data.tab === "queue" || data.tab === "history" ? (data.total === 1 ? "candidate" : "candidates") : data.total === 1 ? "interview" : "interviews"}`
											: " "}
									</p>
									{filtered && (
										<Button
											variant="ghost"
											size="sm"
											onClick={() => {
												setSearchText("");
												applyFilters({
													search: undefined,
													driveId: undefined,
													level: undefined,
													minYears: undefined,
													maxYears: undefined,
												});
											}}
										>
											Clear filters
										</Button>
									)}
								</div>
								{!parsed.success && (
									<Alert variant="destructive">
										<AlertTitle>
											Enter a valid experience range from 0 to 80 years.
										</AlertTitle>
									</Alert>
								)}
								{request.error && (
									<div className="flex items-center gap-2">
										<InterviewAlert error={request.error} />
										<Button
											variant="outline"
											onClick={() => void request.refetch()}
										>
											Try again
										</Button>
									</div>
								)}
								{!data && parsed.success && request.isFetching && (
									<InterviewLoading />
								)}
								{data &&
									(data.items.length ? (
										<div className="overflow-hidden rounded-lg border bg-card text-card-foreground">
											<div
												aria-hidden="true"
												className={`${rowLayout} hidden border-b bg-muted/50 py-2.5 text-xs font-semibold text-muted-foreground sm:grid`}
											>
												<span>Candidate</span>
												<span>
													{tab === "queue"
														? "Reason"
														: tab === "history"
															? "Final outcome"
															: "Interview and panelist"}
												</span>
												<span className="text-right">Details</span>
											</div>
											<ul className="divide-y" data-testid="interview-list">
												{data.items.map((item) =>
													item.action === "schedule" && item.eligible ? (
														<QueueRow
															key={item.id}
															item={item.eligible}
															disabled={changingFilters}
															onOpen={openCandidate}
															onL1={openBooking}
															onHistory={
																item.hasAttempts
																	? (button) => openTimeline(item, button)
																	: undefined
															}
														/>
													) : (
														<WorkspaceRow
															key={item.id}
															item={item}
															tab={data.tab}
															disabled={changingFilters}
															onBooking={openBooking}
															onReview={openReview}
															onHistory={openTimeline}
															onWithdraw={openWithdrawal}
														/>
													),
												)}
											</ul>
										</div>
									) : (
										<InterviewEmpty title={empty[0]} description={empty[1]} />
									))}
								{data && (pageCount > 1 || page > 1) && (
									<nav
										aria-label="Interview pages"
										className="mt-2 flex flex-wrap items-center justify-between gap-2 text-sm"
									>
										<Button
											variant="outline"
											size="sm"
											disabled={page <= 1 || changingFilters}
											onClick={() => setSearch({ page: page - 1 }, false)}
										>
											<ChevronLeft />
											Previous
										</Button>
										<p>
											Page {data.page} of {pageCount}
										</p>
										<Button
											variant="outline"
											size="sm"
											disabled={page >= pageCount || changingFilters}
											onClick={() => setSearch({ page: page + 1 }, false)}
										>
											Next
											<ChevronRight />
										</Button>
									</nav>
								)}
								{id === "queue" && !denied && (
									<FeedbackReviewInbox
										updatesOnly
										page={updatesPage}
										onPage={setUpdatesPage}
										onOpen={openReview}
									/>
								)}
							</div>
						)}
					</TabsContent>
				))}
			</Tabs>
			<Sheet
				open={
					!denied &&
					Boolean(
						candidate || withdrawal || timeline || search.booking || reviewId,
					)
				}
				onOpenChange={(open, details) => {
					if (open) return;
					if (saving) {
						details.cancel();
						return;
					}
					setCandidate(undefined);
					setWithdrawal(undefined);
					setTimeline(undefined);
					if (search.booking || reviewId)
						setSearch({
							booking: undefined,
							version: undefined,
							review: undefined,
						});
				}}
			>
				<SheetContent
					closeDisabled={saving}
					className="gap-0 bg-card data-[side=right]:w-full data-[side=right]:sm:max-w-[34rem]"
					finalFocus={() =>
						opener.current?.isConnected
							? opener.current
							: tab === "queue"
								? actionTab.current
								: searchInput.current
					}
				>
					{reviewId ? (
						<FeedbackReviewSheet
							key={reviewId}
							id={reviewId}
							busy={saving}
							setBusy={setSaving}
						/>
					) : timeline ? (
						<CandidacyTimeline key={timeline.id} item={timeline} />
					) : withdrawal ? (
						<WithdrawCandidacySheet
							key={withdrawal.id}
							candidate={withdrawal}
							busy={saving}
							setBusy={setSaving}
							onWithdraw={onWithdrawn}
						/>
					) : candidate ? (
						<BookingSheet
							key={candidate.id}
							candidate={candidate}
							busy={saving}
							setBusy={setSaving}
							onWithdraw={onWithdrawn}
							onBook={(booking) => {
								setCandidate(undefined);
								setSearchText("");
								window.clearTimeout(searchTimer.current);
								void invalidateHrInterviews(client, booking);
								void navigate({
									search: {
										tab: "scheduled",
										booking,
										search: undefined,
										driveId: undefined,
										level: search.level,
										page: undefined,
										minYears: undefined,
										maxYears: undefined,
									},
									ignoreBlocker: true,
								});
							}}
						/>
					) : (
						search.booking && (
							<HrRoundDetail
								key={search.booking}
								id={search.booking}
								versionId={search.version}
								busy={saving}
								setBusy={setSaving}
							/>
						)
					)}
				</SheetContent>
			</Sheet>
		</section>
	);
}
