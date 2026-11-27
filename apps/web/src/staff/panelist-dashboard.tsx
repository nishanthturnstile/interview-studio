import {
	type PanelistDashboardRound,
	type PanelistRoundGroup,
	panelistDashboardSchema,
} from "@studio/contracts";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ArrowRight, ChevronRight } from "lucide-react";
import { useId } from "react";
import type { z } from "zod";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import {
	accessDenied,
	interviewRequest,
	retryInterviewRead,
} from "../interviews/api";
import {
	formatClock,
	formatDate,
	InterviewAlert,
	InterviewLoading,
	InterviewStatus,
	panelistGroupLabels,
	panelistRoundAction,
	scheduleLabel,
} from "../interviews/display";

type Dashboard = z.infer<typeof panelistDashboardSchema>;

const emptyMessages = {
	attention: "You’re caught up on interviews and feedback.",
	upcoming: "No upcoming interviews assigned.",
	submitted: "Your submitted scorecards will appear here.",
} satisfies Record<PanelistRoundGroup, string>;

function RoundTime({ round }: { round: PanelistDashboardRound }) {
	const { state, submittedAt, closedAt, start, end, timeZone } = round;
	const time = state === "feedback_submitted" ? submittedAt : closedAt;
	if (time) {
		return (
			<time dateTime={time}>
				{state === "feedback_submitted" ? "Submitted" : "Ended"}{" "}
				{formatDate(time, timeZone)}, {formatClock(time, timeZone)} ({timeZone})
			</time>
		);
	}
	if (state === "scheduled" || state === "active")
		return <time dateTime={start}>{scheduleLabel(start, end, timeZone)}</time>;
	return null;
}

function DashboardRound({
	round,
	group,
	primary,
}: {
	round: PanelistDashboardRound;
	group: PanelistRoundGroup;
	primary: boolean;
}) {
	const action = panelistRoundAction(round.state);
	const isSubmitted = group === "submitted";
	return (
		<li className="flex min-w-0 flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 py-3.5 sm:px-5">
			<div className="min-w-0 space-y-1.5 [overflow-wrap:anywhere]">
				<div className="flex flex-wrap items-center gap-x-2 gap-y-1">
					<h3 className="font-semibold">{round.candidate.name}</h3>
					<Badge variant="muted">{round.level.toUpperCase()}</Badge>
					{round.attempt > 1 && (
						<span className="text-xs text-muted-foreground">
							Attempt {round.attempt}
						</span>
					)}
				</div>
				<p className="text-sm text-muted-foreground">{round.drive.title}</p>
				<div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
					{group === "attention" &&
						(round.state === "active" ? (
							<Badge variant="success">
								<span
									className="size-1.5 rounded-full bg-current"
									aria-hidden="true"
								/>
								In progress
							</Badge>
						) : round.state === "scheduled" && round.connected ? (
							<Badge variant="success">Candidate waiting</Badge>
						) : (
							<InterviewStatus state={round.state} />
						))}
					<RoundTime round={round} />
				</div>
			</div>
			<Link
				to="/staff/my-interviews/$roundId"
				params={{ roundId: round.id }}
				hash={action.hash}
				aria-label={`${action.label} for ${round.candidate.name}`}
				className={buttonVariants({
					variant: primary ? "default" : isSubmitted ? "ghost" : "outline",
					size: "sm",
					className: isSubmitted ? "-ml-2.5 text-muted-foreground" : undefined,
				})}
			>
				{action.label}
				{primary && <ArrowRight data-icon="inline-end" aria-hidden="true" />}
				{isSubmitted && (
					<ChevronRight data-icon="inline-end" aria-hidden="true" />
				)}
			</Link>
		</li>
	);
}

function DashboardPanel({
	group,
	page,
}: {
	group: PanelistRoundGroup;
	page: Dashboard[PanelistRoundGroup];
}) {
	const heading = useId();
	const title = panelistGroupLabels[group];
	return (
		<section
			aria-labelledby={heading}
			className="min-w-0 rounded-xl border bg-card"
		>
			<header className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 border-b px-4 py-3 sm:px-5">
				<div className="flex min-w-0 items-center gap-2">
					<h2 id={heading} className="text-base font-semibold tracking-tight">
						{title}
					</h2>
					{group === "attention" && page.total > 0 && (
						<Badge variant="warning" className="tabular-nums">
							{page.total}
						</Badge>
					)}
				</div>
				{page.total > page.items.length && (
					<Link
						to="/staff/my-interviews"
						search={{ group }}
						aria-label={`View all in ${title}`}
						className="inline-flex min-h-8 items-center gap-1 rounded-sm text-sm font-semibold text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
					>
						View all <ChevronRight className="size-3.5" aria-hidden="true" />
					</Link>
				)}
			</header>
			{page.items.length ? (
				<ul className="divide-y">
					{page.items.map((round, index) => (
						<DashboardRound
							key={round.id}
							round={round}
							group={group}
							primary={group === "attention" && index === 0}
						/>
					))}
				</ul>
			) : (
				<p className="px-4 py-4 text-sm text-muted-foreground sm:px-5">
					{emptyMessages[group]}
				</p>
			)}
		</section>
	);
}

export function PanelistDashboard({ staffId }: { staffId: string }) {
	const request = useQuery({
		queryKey: ["panelist-dashboard", staffId],
		queryFn: ({ signal }) =>
			interviewRequest(
				"/staff/my-interviews/dashboard",
				panelistDashboardSchema,
				{ signal },
			),
		refetchOnWindowFocus: "always",
		refetchInterval: ({ state }) => (accessDenied(state.error) ? false : 8_000),
		retry: retryInterviewRead,
	});
	const denied = accessDenied(request.error);
	const dashboard = denied ? undefined : request.data;
	return (
		<section className="@container/dashboard mx-auto flex w-full max-w-6xl min-w-0 flex-col gap-5 px-4 py-8 sm:px-8 sm:py-10">
			<header className="flex flex-wrap items-center justify-between gap-3">
				<h1 className="text-3xl leading-tight font-bold tracking-tight">
					Panelist dashboard
				</h1>
				<Link
					to="/staff/my-interviews"
					className={buttonVariants({ variant: "outline" })}
				>
					All interviews{" "}
					<ArrowRight data-icon="inline-end" aria-hidden="true" />
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
					<div className="grid items-start gap-4 @min-[40rem]/dashboard:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
						<DashboardPanel group="attention" page={dashboard.attention} />
						<DashboardPanel group="upcoming" page={dashboard.upcoming} />
					</div>
					<DashboardPanel group="submitted" page={dashboard.submitted} />
				</>
			)}
		</section>
	);
}
