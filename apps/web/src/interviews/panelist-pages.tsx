import {
	assignedInterviewSchema,
	assignedInterviewsSchema,
	canViewAssignedInterviews,
	interviewResultSchema,
} from "@studio/contracts";
import { getRouteApi, Link, useLocation } from "@tanstack/react-router";
import {
	ArrowLeft,
	CalendarDays,
	ChevronLeft,
	ChevronRight,
	UserRoundCheck,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button, buttonVariants } from "@/components/ui/button";
import {
	interviewRequest,
	useCommandKey,
	useInterviewPoll,
	useInterviewResource,
} from "./api";
import { PanelistAssessment } from "./assessment";
import {
	AttendanceSummary,
	experienceLabel,
	InterviewAlert,
	InterviewEmpty,
	InterviewLoading,
	InterviewStatus,
	MeetingDetails,
	panelistGroupLabels,
	panelistRoundAction,
	scheduleLabel,
} from "./display";
import { EndInterviewDialog } from "./end-dialog";

const staffRoute = getRouteApi("/staff");
const listRoute = getRouteApi("/staff/my-interviews");
const roundRoute = getRouteApi("/staff/my-interviews/$roundId");
const resolveRoute = getRouteApi(
	"/staff/my-interviews/invitations/$invitationId",
);
const shell =
	"mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 py-8 sm:px-8 sm:py-10";
const detailLabel =
	"flex items-center gap-2 text-sm font-semibold text-muted-foreground";

export function MyInterviews() {
	const { role } = staffRoute.useLoaderData();
	const { page = 1, group } = listRoute.useSearch();
	const navigate = listRoute.useNavigate();
	const allowed = canViewAssignedInterviews(role);
	const request = useInterviewResource(
		allowed
			? `/staff/my-interviews?page=${page}${group ? `&group=${group}` : ""}`
			: null,
		assignedInterviewsSchema,
		{ keepPrevious: true },
	);
	return (
		<section className={shell}>
			<header className="flex flex-wrap items-start justify-between gap-3">
				<div>
					<h1 className="text-3xl leading-tight font-bold">My interviews</h1>
					<p className="mt-2 text-sm text-muted-foreground">
						{group
							? panelistGroupLabels[group]
							: "View your assigned rounds and check when candidates arrive."}
					</p>
				</div>
				{group && (
					<Link
						to="/staff/my-interviews"
						search={{}}
						className={buttonVariants({ variant: "outline", size: "sm" })}
					>
						All interviews
					</Link>
				)}
			</header>
			{!allowed ? (
				<InterviewEmpty
					title="My interviews is available to panelists"
					description="Use the staff account assigned to the round."
				/>
			) : request.error !== undefined ? (
				<>
					<InterviewAlert error={request.error} />
					<Button
						className="self-start"
						variant="outline"
						onClick={request.refresh}
					>
						Try again
					</Button>
				</>
			) : !request.data ? (
				<InterviewLoading />
			) : !request.data.items.length ? (
				<InterviewEmpty
					title={
						page > 1 || group
							? "No interviews in this view"
							: "No assigned interviews"
					}
					description={
						page > 1
							? "Return to the previous page to see your assigned rounds."
							: group
								? "Browse all interviews to see your other assignments."
								: "Your rounds will appear here when HR assigns you."
					}
				/>
			) : (
				<ul
					aria-busy={request.loading}
					className="divide-y rounded-lg border bg-card"
				>
					{request.data.items.map((round) => {
						const action = group
							? panelistRoundAction(round.state)
							: { label: "Open interview" };
						return (
							<li
								key={round.id}
								className="grid items-center gap-3 px-4 py-4 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.35fr)_auto] sm:px-5"
							>
								<div className="min-w-0 [overflow-wrap:anywhere]">
									<p className="font-semibold">{round.candidate.name}</p>
									<p className="mt-0.5 text-sm text-muted-foreground">
										{round.drive.title} · {round.level.toUpperCase()}
									</p>
								</div>
								<div className="text-sm">
									<p>{scheduleLabel(round.start, round.end, round.timeZone)}</p>
									<p className="mt-0.5 text-muted-foreground">
										{experienceLabel(round.candidate.years)}
									</p>
								</div>
								<div className="flex flex-wrap items-center gap-2 sm:justify-end">
									<InterviewStatus state={round.state} />
									<Link
										to="/staff/my-interviews/$roundId"
										params={{ roundId: round.id }}
										hash={action.hash}
										aria-label={`${action.label} for ${round.candidate.name}`}
										className={buttonVariants({
											variant: "outline",
											size: "sm",
										})}
									>
										{action.label}
									</Link>
								</div>
							</li>
						);
					})}
				</ul>
			)}
			{request.data && (page > 1 || request.data.hasNext) && (
				<nav
					aria-label="Assigned interview pages"
					className="flex flex-wrap items-center justify-between gap-2 text-sm"
				>
					<Button
						variant="outline"
						size="sm"
						disabled={page <= 1 || request.loading}
						onClick={() => void navigate({ search: { page: page - 1, group } })}
					>
						<ChevronLeft />
						Previous
					</Button>
					<p role="status">Page {request.data.page}</p>
					<Button
						variant="outline"
						size="sm"
						disabled={!request.data.hasNext || request.loading}
						onClick={() => void navigate({ search: { page: page + 1, group } })}
					>
						Next
						<ChevronRight />
					</Button>
				</nav>
			)}
		</section>
	);
}

export function ResolveStaffInvitation() {
	const { invitationId } = resolveRoute.useParams();
	const navigate = resolveRoute.useNavigate();
	const { role } = staffRoute.useLoaderData();
	const allowed = canViewAssignedInterviews(role);
	const request = useInterviewResource(
		allowed ? `/staff/my-interviews/invitations/${invitationId}` : null,
		interviewResultSchema,
	);
	const id = request.data?.id;
	useEffect(() => {
		if (id)
			void navigate({
				to: "/staff/my-interviews/$roundId",
				params: { roundId: id },
				replace: true,
			});
	}, [id, navigate]);
	return (
		<section className={shell}>
			<h1 className="text-3xl font-bold">Open interview</h1>
			{!allowed || request.error !== undefined ? (
				<InterviewEmpty
					title="Interview unavailable"
					description="Use the panelist account assigned to the current invitation."
				/>
			) : (
				<InterviewLoading />
			)}
			{allowed && (
				<Link
					to="/staff/my-interviews"
					className={buttonVariants({
						variant: "outline",
						className: "self-start",
					})}
				>
					Back to My interviews
				</Link>
			)}
		</section>
	);
}

export function PanelistRound() {
	const { roundId } = roundRoute.useParams();
	const { id: staffId, role } = staffRoute.useLoaderData();
	const allowed = canViewAssignedInterviews(role);
	const path = `/staff/my-interviews/${roundId}`;
	const [refresh, setRefresh] = useState(0);
	const request = useInterviewPoll(
		allowed ? path : null,
		assignedInterviewSchema,
		{ refresh },
	);
	const round = request?.data;
	const hash = useLocation({ select: (location) => location.hash });
	const assessmentAnchor = useRef<HTMLElement>(null);
	const showAssessment = Boolean(
		round && (round.state !== "scheduled" || round.level === "l2"),
	);
	useEffect(() => {
		if (hash !== "assessment" || !showAssessment) return;
		assessmentAnchor.current?.focus({ preventScroll: true });
		assessmentAnchor.current?.scrollIntoView({ block: "start" });
	}, [hash, showAssessment]);
	const [confirming, setConfirming] = useState(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<unknown>();
	const withKey = useCommandKey();
	async function change(action: "start" | "end") {
		if (!round || busy) return;
		setBusy(true);
		setError(undefined);
		try {
			await interviewRequest(`${path}/commands`, interviewResultSchema, {
				data: withKey({ action, revision: round.revision }),
			});
			setConfirming(false);
			setRefresh((value) => value + 1);
		} catch (error) {
			setError(error);
			setRefresh((value) => value + 1);
		} finally {
			setBusy(false);
		}
	}
	return (
		<section className="@container/round mx-auto flex w-full max-w-[86rem] min-w-0 flex-col gap-6 px-4 py-5 sm:px-8 sm:py-7">
			<Link
				to="/staff/my-interviews"
				className={buttonVariants({
					variant: "ghost",
					size: "sm",
					className: "-ml-2 self-start text-muted-foreground",
				})}
			>
				<ArrowLeft data-icon="inline-start" />
				My interviews
			</Link>
			{!allowed || request?.terminal ? (
				<InterviewEmpty
					title="Interview unavailable"
					description="Only the panelist currently assigned to this round can open it."
				/>
			) : !round ? (
				request?.error !== undefined ? (
					<InterviewAlert error={request.error} />
				) : (
					<InterviewLoading />
				)
			) : (
				<>
					<header className="flex flex-wrap items-center justify-between gap-x-6 gap-y-4">
						<div className="min-w-0 space-y-2 [overflow-wrap:anywhere]">
							<div className="flex flex-wrap items-center gap-x-4 gap-y-2">
								<h1 className="min-w-0 text-3xl leading-tight font-bold tracking-tight sm:text-4xl">
									{round.candidate.name}
								</h1>
								<div role="status">
									<InterviewStatus state={round.state} />
								</div>
							</div>
							<div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
								<span className="rounded-md bg-accent px-2 py-0.5 font-semibold text-accent-foreground">
									{round.level.toUpperCase()}
								</span>
								<span className="font-medium text-foreground">
									{round.drive.title}
								</span>
								<span>{experienceLabel(round.candidate.years)}</span>
							</div>
						</div>
						{round.state === "active" && (
							<EndInterviewDialog
								open={confirming}
								setOpen={(value) => {
									setConfirming(value);
									setError(undefined);
								}}
								pending={busy}
								error={error}
								onEnd={() => void change("end")}
							/>
						)}
					</header>
					<div className="grid divide-y rounded-xl border bg-card @min-[47rem]/round:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)_minmax(0,0.85fr)] @min-[47rem]/round:divide-x @min-[47rem]/round:divide-y-0">
						<section className="min-w-0 space-y-2 px-4 py-3.5 sm:px-5">
							<h2 className={detailLabel}>
								<CalendarDays className="size-4" aria-hidden="true" />
								Interview details
							</h2>
							<div className="text-sm tabular-nums [overflow-wrap:anywhere]">
								<p className="font-medium">
									{scheduleLabel(round.start, round.end, round.timeZone)}
								</p>
								<p className="mt-0.5 text-muted-foreground">
									{round.duration} minutes
								</p>
							</div>
						</section>
						<section className="min-w-0 space-y-2 px-4 py-3.5 sm:px-5">
							<h2 className={detailLabel}>
								<UserRoundCheck className="size-4" aria-hidden="true" />
								Attendance
							</h2>
							<div className="flex flex-col items-start gap-3 [overflow-wrap:anywhere]">
								<div role="status">
									<AttendanceSummary round={round} />
								</div>
								{request?.error !== undefined && (
									<InterviewAlert error={request.error} />
								)}
								{error !== undefined && !confirming && (
									<InterviewAlert error={error} />
								)}
								{round.state === "scheduled" && (
									<Button
										disabled={
											busy ||
											!round.attendance.connected ||
											request?.error !== undefined
										}
										onClick={() => void change("start")}
									>
										{busy ? "Starting…" : "Start interview"}
									</Button>
								)}
							</div>
						</section>
						<section className="flex min-w-0 flex-col gap-2 px-4 py-3.5 sm:px-5">
							<h2 className={detailLabel}>Meeting</h2>
							<MeetingDetails meeting={round.meeting} />
						</section>
					</div>
					{showAssessment && (
						<section
							id="assessment"
							aria-label="Assessment"
							ref={assessmentAnchor}
							tabIndex={-1}
							className="min-w-0 scroll-mt-4 focus:outline-none"
						>
							<PanelistAssessment
								key={round.id}
								roundId={round.id}
								staffId={staffId}
								level={round.level}
								scheduled={round.state === "scheduled"}
								attemptRevision={round.revision}
								onSubmitted={() => setRefresh((value) => value + 1)}
							/>
						</section>
					)}
				</>
			)}
		</section>
	);
}
