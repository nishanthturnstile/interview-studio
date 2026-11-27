import type {
	EligibleInterviewCandidate,
	hrInterviewDashboardSchema,
	InterviewWorkspaceItem,
	InterviewWorkspaceQuery,
} from "@studio/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useBlocker, useNavigate } from "@tanstack/react-router";
import { ArrowRight } from "lucide-react";
import { type ReactNode, useId, useRef, useState } from "react";
import type { z } from "zod";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { accessDenied } from "../interviews/api";
import {
	formatClock,
	formatDate,
	InterviewAlert,
	InterviewLoading,
	InterviewStatus,
	scheduleLabel,
	workspaceActionLabels,
} from "../interviews/display";
import { BookingSheet, WithdrawCandidacySheet } from "../interviews/hr-actions";
import {
	hrDashboardQuery,
	invalidateHrInterviews,
} from "../interviews/hr-queries";
import { CandidacyTimeline } from "../interviews/hr-timeline";
import { decisionLabels } from "../interviews/scorecard";

type WorkspaceTab = InterviewWorkspaceQuery["tab"];
type DashboardPage = z.infer<typeof hrInterviewDashboardSchema>[WorkspaceTab];

const panels = {
	queue: {
		title: "Action needed",
		link: "View queue",
		empty: "No HR actions needed.",
	},
	scheduled: {
		title: "Upcoming and live",
		link: "View schedule",
		empty: "No scheduled interviews.",
	},
	awaiting: {
		title: "Awaiting feedback",
		link: "View feedback queue",
		empty: "No interviews awaiting feedback.",
	},
	history: {
		title: "Recent outcomes",
		link: "View history",
		empty: "No completed outcomes yet.",
	},
} satisfies Record<
	WorkspaceTab,
	{ title: string; link: string; empty: string }
>;

const summaryLink =
	"inline-flex min-h-8 items-center gap-1.5 rounded-sm text-sm font-semibold text-muted-foreground underline-offset-4 hover:text-foreground hover:underline";
const sheetClass =
	"gap-0 bg-card data-[side=right]:w-full data-[side=right]:sm:max-w-[34rem]";

function DashboardPanel({
	tab,
	page,
	children,
}: {
	tab: WorkspaceTab;
	page: DashboardPage;
	children: (item: InterviewWorkspaceItem) => ReactNode;
}) {
	const heading = useId();
	const { title, link, empty } = panels[tab];
	const { total } = page;
	return (
		<section
			aria-labelledby={heading}
			className="min-w-0 rounded-xl border bg-card"
		>
			<div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 border-b px-4 py-3 sm:px-5">
				<div className="flex items-center gap-2">
					<h2 id={heading} className="text-base font-semibold tracking-tight">
						{title}
					</h2>
					<Badge
						variant={tab === "queue" && total > 0 ? "warning" : "muted"}
						className="tabular-nums"
					>
						{total}
					</Badge>
				</div>
				<Link to="/staff/interviews" search={{ tab }} className={summaryLink}>
					{link} <ArrowRight className="size-3.5" aria-hidden="true" />
				</Link>
			</div>
			{page.items.length ? (
				<ul className="divide-y">
					{page.items.map((item) => (
						<li
							key={item.id}
							className="flex min-w-0 flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 py-3.5 sm:px-5"
						>
							{children(item)}
						</li>
					))}
				</ul>
			) : (
				<p className="px-4 py-4 text-sm text-muted-foreground sm:px-5">
					{empty}
				</p>
			)}
		</section>
	);
}

function CandidateSummary({
	item,
	children,
}: {
	item: InterviewWorkspaceItem;
	children?: ReactNode;
}) {
	return (
		<div className="min-w-0 [overflow-wrap:anywhere]">
			<p className="font-semibold">{item.name}</p>
			<p className="mt-0.5 text-sm text-muted-foreground">
				{children ?? item.drive.title}
			</p>
		</div>
	);
}

function DashboardAction({
	item,
	onSchedule,
	onWithdraw,
}: {
	item: InterviewWorkspaceItem;
	onSchedule: (
		candidate: EligibleInterviewCandidate,
		button: HTMLButtonElement,
	) => void;
	onWithdraw: (
		candidate: EligibleInterviewCandidate,
		button: HTMLButtonElement,
	) => void;
}) {
	const labels = workspaceActionLabels(item);
	const { eligible, reviewId, round } = item;
	if (!labels) return null;
	const actionName = `${labels.action} for ${item.name}`;
	const actionClass = buttonVariants({ size: "sm", variant: "outline" });
	return (
		<>
			<CandidateSummary item={item}>
				{labels.status} · {item.drive.title}
			</CandidateSummary>
			{item.action === "schedule" && eligible ? (
				<Button
					size="sm"
					aria-label={actionName}
					onClick={(event) => onSchedule(eligible, event.currentTarget)}
				>
					{labels.action}
				</Button>
			) : item.action === "review_skills" ? (
				<div className="flex flex-wrap items-center gap-2">
					<Link
						to="/staff/drives/$driveId"
						params={{ driveId: item.drive.id }}
						hash="scorecard-skills"
						className={actionClass}
						aria-label={actionName}
					>
						{labels.action}
					</Link>
					{eligible && (
						<Button
							variant="ghost"
							size="sm"
							aria-label={`Withdraw candidacy for ${item.name}`}
							onClick={(event) => onWithdraw(eligible, event.currentTarget)}
						>
							Withdraw candidacy
						</Button>
					)}
				</div>
			) : (
				<Link
					to="/staff/interviews"
					search={{
						tab: "queue",
						review: reviewId ?? undefined,
						booking: round?.id,
					}}
					className={actionClass}
					aria-label={actionName}
				>
					{labels.action}
				</Link>
			)}
		</>
	);
}

function OpenInterview({
	item,
	tab,
}: {
	item: InterviewWorkspaceItem;
	tab: "scheduled" | "awaiting";
}) {
	const { round } = item;
	if (!round) return null;
	const label = tab === "scheduled" ? "View booking" : "View interview";
	return (
		<>
			<CandidateSummary item={item}>
				{round.level.toUpperCase()} · {round.panelist.name}
				<span className="mt-0.5 block">
					{tab === "awaiting"
						? round.closedAt &&
							`Ended ${formatDate(round.closedAt, round.timeZone)}, ${formatClock(round.closedAt, round.timeZone)} (${round.timeZone})`
						: scheduleLabel(round.start, round.end, round.timeZone)}
				</span>
			</CandidateSummary>
			<div className="flex flex-wrap items-center gap-2">
				{round.state === "active" && <InterviewStatus state={round.state} />}
				<Link
					to="/staff/interviews"
					search={{ tab, booking: round.id }}
					className={summaryLink}
					aria-label={`${label} for ${item.name}`}
				>
					{label}
				</Link>
			</div>
		</>
	);
}

type DashboardSheet =
	| { kind: "schedule" | "withdraw"; candidate: EligibleInterviewCandidate }
	| { kind: "history"; item: InterviewWorkspaceItem };

export function HrDashboard() {
	const navigate = useNavigate();
	const client = useQueryClient();
	const request = useQuery(hrDashboardQuery());
	const [sheet, setSheet] = useState<DashboardSheet>();
	const [saving, setSaving] = useState(false);
	const [notice, setNotice] = useState("");
	const heading = useRef<HTMLHeadingElement>(null);
	const opener = useRef<HTMLButtonElement>(null);
	const denied = accessDenied(request.error);
	const dashboard = denied ? undefined : request.data;
	useBlocker({ shouldBlockFn: () => saving, enableBeforeUnload: saving });

	function openCandidate(
		kind: "schedule" | "withdraw",
		candidate: EligibleInterviewCandidate,
		button: HTMLButtonElement,
	) {
		opener.current = button;
		setNotice("");
		setSheet({ kind, candidate });
	}
	function onWithdrawn() {
		setSheet(undefined);
		setNotice("Candidate withdrawn.");
		void invalidateHrInterviews(client);
	}

	return (
		<section className="@container/dashboard mx-auto flex w-full max-w-6xl min-w-0 flex-col gap-5 px-4 py-8 sm:px-8 sm:py-10">
			<header className="flex flex-wrap items-center justify-between gap-x-5 gap-y-3">
				<div className="min-w-0">
					<h1
						ref={heading}
						tabIndex={-1}
						className="text-3xl leading-tight font-bold tracking-tight"
					>
						Dashboard
					</h1>
					<p className="mt-1 text-sm text-muted-foreground">
						Interview coordination across your drives
					</p>
				</div>
				<Link
					to="/staff/interviews"
					className={buttonVariants({ variant: "outline" })}
				>
					Open Interviews <ArrowRight aria-hidden="true" />
				</Link>
			</header>
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
			{request.isPending && <InterviewLoading />}
			{dashboard && (
				<>
					{notice && (
						<p
							role="status"
							className="rounded-md bg-success px-4 py-2 text-sm text-success-foreground"
						>
							{notice}
						</p>
					)}
					<div className="grid items-start gap-4 @min-[41rem]/dashboard:grid-cols-[minmax(0,1.55fr)_minmax(0,1fr)]">
						<DashboardPanel tab="queue" page={dashboard.queue}>
							{(item) => (
								<DashboardAction
									item={item}
									onSchedule={(candidate, button) =>
										openCandidate("schedule", candidate, button)
									}
									onWithdraw={(candidate, button) =>
										openCandidate("withdraw", candidate, button)
									}
								/>
							)}
						</DashboardPanel>
						<DashboardPanel tab="scheduled" page={dashboard.scheduled}>
							{(item) => <OpenInterview item={item} tab="scheduled" />}
						</DashboardPanel>
					</div>
					<div className="grid items-start gap-4 @min-[41rem]/dashboard:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]">
						<DashboardPanel tab="awaiting" page={dashboard.awaiting}>
							{(item) => <OpenInterview item={item} tab="awaiting" />}
						</DashboardPanel>
						<DashboardPanel tab="history" page={dashboard.history}>
							{(item) => (
								<>
									<CandidateSummary item={item} />
									<div className="flex flex-wrap items-center gap-2">
										{item.outcome && (
											<Badge
												variant={
													item.outcome === "selected" ? "success" : "muted"
												}
											>
												{item.outcome === "withdrawn"
													? "Withdrawn"
													: decisionLabels[item.outcome]}
											</Badge>
										)}
										<button
											type="button"
											className={summaryLink}
											aria-label={`View interview history for ${item.name}`}
											onClick={(event) => {
												opener.current = event.currentTarget;
												setSheet({ kind: "history", item });
											}}
										>
											View details
										</button>
									</div>
								</>
							)}
						</DashboardPanel>
					</div>
				</>
			)}
			<Sheet
				open={Boolean(sheet) && !denied}
				onOpenChange={(open, details) => {
					if (open) return;
					if (saving) {
						details.cancel();
						return;
					}
					setSheet(undefined);
				}}
			>
				<SheetContent
					closeDisabled={saving}
					className={sheetClass}
					finalFocus={() =>
						opener.current?.isConnected ? opener.current : heading.current
					}
				>
					{sheet?.kind === "schedule" && (
						<BookingSheet
							key={sheet.candidate.id}
							candidate={sheet.candidate}
							busy={saving}
							setBusy={setSaving}
							onWithdraw={onWithdrawn}
							onBook={(booking) => {
								setSheet(undefined);
								void invalidateHrInterviews(client, booking);
								void navigate({
									to: "/staff/interviews",
									search: { tab: "scheduled", booking },
									ignoreBlocker: true,
								});
							}}
						/>
					)}
					{sheet?.kind === "withdraw" && (
						<WithdrawCandidacySheet
							key={sheet.candidate.id}
							candidate={sheet.candidate}
							busy={saving}
							setBusy={setSaving}
							onWithdraw={onWithdrawn}
						/>
					)}
					{sheet?.kind === "history" && (
						<CandidacyTimeline key={sheet.item.id} item={sheet.item} />
					)}
				</SheetContent>
			</Sheet>
		</section>
	);
}
