import {
	canManageInterviews,
	type EligibleInterviewCandidate,
	type HrInterview,
	interviewListQuerySchema,
} from "@studio/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getRouteApi, useBlocker } from "@tanstack/react-router";
import {
	CalendarDays,
	ChevronDown,
	ChevronLeft,
	ChevronRight,
	RefreshCw,
	Search,
	SlidersHorizontal,
} from "lucide-react";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { Alert, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
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
	InterviewAlert,
	InterviewEmpty,
	InterviewLoading,
	InterviewStatus,
	scheduleLabel,
} from "./display";
import { BookingSheet, HrRoundDetail } from "./hr-actions";
import { hrInterviewsQuery, invalidateHrInterviews } from "./hr-queries";

const staffRoute = getRouteApi("/staff");
const route = getRouteApi("/staff/interviews");
const tabs = [
	{ id: "queue", label: "To schedule" },
	{ id: "scheduled", label: "Scheduled" },
	{ id: "history", label: "History" },
] as const;
const emptyCopy = {
	queue: [
		"No candidates to schedule",
		"Confirmed candidates appear here when they’re eligible for L1.",
	],
	scheduled: [
		"No scheduled interviews",
		"New bookings appear here until the round closes.",
	],
	history: [
		"No past interviews",
		"Rounds awaiting feedback and closed bookings appear here.",
	],
};

type Range = { minYears?: string; maxYears?: string };

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
		const result = interviewListQuerySchema.safeParse(draft);
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
						className="group h-10 min-w-0 justify-start px-3"
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
}: {
	item: EligibleInterviewCandidate;
	disabled: boolean;
	onOpen: (item: EligibleInterviewCandidate, button: HTMLButtonElement) => void;
}) {
	return (
		<li className={`grid ${rowLayout} py-3.5`}>
			<div className="min-w-0 [overflow-wrap:anywhere]">
				<p className="font-semibold">{item.name}</p>
				<p className="mt-0.5 text-sm text-muted-foreground">{item.email}</p>
			</div>
			<div className="col-start-1 row-start-2 min-w-0 text-sm [overflow-wrap:anywhere] sm:col-start-auto sm:row-start-auto">
				<p>{item.drive.title}</p>
				<p className="mt-0.5 text-muted-foreground">
					{experienceLabel(item.years)}
				</p>
			</div>
			<Button
				variant="outline"
				size="sm"
				className="col-start-2 row-span-2 row-start-1 justify-self-end sm:col-start-auto sm:row-span-1 sm:row-start-auto"
				disabled={disabled}
				aria-label={`Schedule L1 for ${item.name}`}
				onClick={(event) => onOpen(item, event.currentTarget)}
			>
				<CalendarDays data-icon="inline-start" />
				Schedule L1
			</Button>
		</li>
	);
}

function BookingRow({
	round,
	disabled,
	onOpen,
}: {
	round: HrInterview;
	disabled: boolean;
	onOpen: (id: string, button: HTMLButtonElement) => void;
}) {
	return (
		<li className={`grid ${rowLayout} py-3.5`}>
			<div className="min-w-0 [overflow-wrap:anywhere]">
				<p className="font-semibold">{round.candidate.name}</p>
				<p className="mt-0.5 text-sm text-muted-foreground">
					{round.drive.title} · {round.level.toUpperCase()}
					{round.attempt > 1 && ` · Attempt ${round.attempt}`}
				</p>
			</div>
			<div className="col-start-1 row-start-2 min-w-0 text-sm [overflow-wrap:anywhere] sm:col-start-auto sm:row-start-auto">
				<p className="tabular-nums">
					{scheduleLabel(round.start, round.end, round.timeZone)}
				</p>
				<p className="mt-0.5 text-muted-foreground">
					{round.panelist.name}
					{round.meeting.mode === "virtual" &&
						!round.meeting.teamsUrl &&
						" · Teams link pending"}
				</p>
			</div>
			<div className="col-start-2 row-span-2 row-start-1 flex flex-col items-end gap-1 sm:col-start-auto sm:row-span-1 sm:row-start-auto">
				<InterviewStatus state={round.state} />
				<Button
					variant="ghost"
					size="sm"
					disabled={disabled}
					aria-label={`View booking for ${round.candidate.name}`}
					onClick={(event) => onOpen(round.id, event.currentTarget)}
				>
					View booking <ChevronRight data-icon="inline-end" />
				</Button>
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
	const page = search.page ?? 1;
	const urlSearch = search.search ?? "";
	const [searchText, setSearchText] = useState(urlSearch);
	const searchTimer = useRef<number>(undefined);
	useEffect(() => {
		setSearchText(urlSearch);
	}, [urlSearch]);
	useEffect(() => () => window.clearTimeout(searchTimer.current), []);
	const range = { minYears: search.minYears, maxYears: search.maxYears };
	const parsed = interviewListQuerySchema.safeParse({
		tab,
		page,
		search: urlSearch,
		driveId: search.driveId,
		...range,
	});
	const request = useQuery({
		...hrInterviewsQuery(parsed.data ?? { tab, page, search: "" }),
		enabled: allowed && parsed.success,
		placeholderData: (previous) => previous,
	});
	const [candidate, setCandidate] = useState<EligibleInterviewCandidate>();
	const [notice, setNotice] = useState("");
	const [saving, setSaving] = useState(false);
	useBlocker({
		shouldBlockFn: () => saving,
		enableBeforeUnload: saving,
	});
	const searchInput = useRef<HTMLInputElement>(null);
	const opener = useRef<HTMLButtonElement>(null);
	const denied = accessDenied(request.error);

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
			range.minYears !== undefined ||
			range.maxYears !== undefined,
	);
	const pageCount = data
		? Math.max(1, Math.ceil(data.total / data.pageSize))
		: 1;
	const changingFilters = request.isPlaceholderData || searchText !== urlSearch;
	const empty = filtered
		? ["No matches", "Try changing your search, drive, or experience range."]
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
		setSearch({ booking });
	}

	return (
		<section className="mx-auto flex w-full max-w-6xl flex-col gap-5 px-4 py-8 sm:px-8 sm:py-10">
			<header>
				<h1 className="text-3xl leading-tight font-bold tracking-tight">
					Interviews
				</h1>
				<p className="mt-1.5 text-sm text-muted-foreground">
					Schedule L1 across drives and manage interview bookings.
				</p>
			</header>
			<Tabs
				className="min-w-0 gap-4"
				value={tab}
				onValueChange={(next) => {
					const target = tabs.find(({ id }) => id === next);
					if (target && target.id !== tab) {
						setNotice("");
						applyFilters({ tab: target.id }, false);
					}
				}}
			>
				<div className="overflow-hidden rounded-lg border bg-card">
					<div className="flex flex-wrap items-center justify-between gap-1 border-b px-3 sm:px-4">
						<TabsList variant="line" className="h-12 max-w-full gap-3">
							{tabs.map(({ id, label }) => (
								<TabsTrigger
									className="h-full after:bottom-[-3px]"
									key={id}
									value={id}
								>
									{label}
								</TabsTrigger>
							))}
						</TabsList>
						<Button
							variant="ghost"
							size="icon-sm"
							title="Refresh interviews"
							aria-label="Refresh interviews"
							disabled={
								request.isFetching || changingFilters || !parsed.success
							}
							onClick={() => void request.refetch()}
						>
							<RefreshCw
								className={
									request.isFetching ? "motion-safe:animate-spin" : undefined
								}
							/>
						</Button>
					</div>
					<FieldGroup className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] items-start gap-2.5 p-3 sm:grid-cols-[minmax(0,1.8fr)_minmax(9rem,1fr)_minmax(8.5rem,auto)] sm:p-4">
						<Field className="col-span-full sm:col-span-1">
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
											? `${data.total} ${data.tab === "queue" ? (data.total === 1 ? "candidate" : "candidates") : data.total === 1 ? "booking" : "bookings"}`
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
														? "Drive and experience"
														: "Interview and panelist"}
												</span>
												<span className="text-right">
													{tab === "queue" ? "" : "Status"}
												</span>
											</div>
											<ul className="divide-y" data-testid="interview-list">
												{data.tab === "queue"
													? data.items.map((item) => (
															<QueueRow
																key={item.id}
																item={item}
																disabled={changingFilters}
																onOpen={openCandidate}
															/>
														))
													: data.items.map((round) => (
															<BookingRow
																key={round.id}
																round={round}
																disabled={changingFilters}
																onOpen={openBooking}
															/>
														))}
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
							</div>
						)}
					</TabsContent>
				))}
			</Tabs>
			<Sheet
				open={!denied && Boolean(candidate || search.booking)}
				onOpenChange={(open, details) => {
					if (open) return;
					if (saving) {
						details.cancel();
						return;
					}
					setCandidate(undefined);
					if (search.booking) setSearch({ booking: undefined });
				}}
			>
				<SheetContent
					closeDisabled={saving}
					className="gap-0 bg-card data-[side=right]:w-full data-[side=right]:sm:max-w-[34rem]"
					finalFocus={() =>
						opener.current?.isConnected ? opener.current : searchInput.current
					}
				>
					{candidate ? (
						<BookingSheet
							key={candidate.id}
							candidate={candidate}
							busy={saving}
							setBusy={setSaving}
							onWithdraw={() => {
								setCandidate(undefined);
								setNotice("Candidate withdrawn.");
								void invalidateHrInterviews(client);
							}}
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
