import {
	assignedInterviewSchema,
	assignedInterviewsSchema,
	canViewAssignedInterviews,
	interviewResultSchema,
} from "@studio/contracts";
import { getRouteApi, Link } from "@tanstack/react-router";
import { ArrowLeft, ChevronLeft, ChevronRight } from "lucide-react";
import { useEffect, useState } from "react";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
	interviewRequest,
	useCommandKey,
	useInterviewPoll,
	useInterviewResource,
} from "./api";
import {
	AttendanceSummary,
	experienceLabel,
	InterviewAlert,
	InterviewEmpty,
	InterviewLoading,
	InterviewStatus,
	ScheduleCard,
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

export function MyInterviews() {
	const { role } = staffRoute.useLoaderData();
	const { page = 1 } = listRoute.useSearch();
	const navigate = listRoute.useNavigate();
	const allowed = canViewAssignedInterviews(role);
	const request = useInterviewResource(
		allowed ? `/staff/my-interviews?page=${page}` : null,
		assignedInterviewsSchema,
		{ keepPrevious: true },
	);
	return (
		<section className={shell}>
			<header>
				<h1 className="text-3xl leading-tight font-bold">My interviews</h1>
				<p className="mt-2 text-sm text-muted-foreground">
					View your assigned rounds and check when candidates arrive.
				</p>
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
						page > 1 ? "No interviews on this page" : "No assigned interviews"
					}
					description={
						page > 1
							? "Return to the previous page to see your assigned rounds."
							: "Your rounds will appear here when HR assigns you."
					}
				/>
			) : (
				<ul
					aria-busy={request.loading}
					className="divide-y rounded-lg border bg-card"
				>
					{request.data.items.map((round) => (
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
									aria-label={`Open interview for ${round.candidate.name}`}
									className={buttonVariants({ variant: "outline", size: "sm" })}
								>
									Open interview
								</Link>
							</div>
						</li>
					))}
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
						onClick={() => void navigate({ search: { page: page - 1 } })}
					>
						<ChevronLeft />
						Previous
					</Button>
					<p role="status">Page {request.data.page}</p>
					<Button
						variant="outline"
						size="sm"
						disabled={!request.data.hasNext || request.loading}
						onClick={() => void navigate({ search: { page: page + 1 } })}
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
	const { role } = staffRoute.useLoaderData();
	const allowed = canViewAssignedInterviews(role);
	const path = `/staff/my-interviews/${roundId}`;
	const [refresh, setRefresh] = useState(0);
	const request = useInterviewPoll(
		allowed ? path : null,
		assignedInterviewSchema,
		{ refresh },
	);
	const round = request?.data;
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
		<section className={shell}>
			<Link
				to="/staff/my-interviews"
				className={buttonVariants({
					variant: "ghost",
					className: "self-start",
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
					<header className="flex flex-wrap items-start justify-between gap-3">
						<div className="min-w-0 [overflow-wrap:anywhere]">
							<h1 className="text-3xl leading-tight font-bold">
								{round.candidate.name}
							</h1>
							<p className="mt-2 text-sm text-muted-foreground">
								{round.drive.title} · {round.level.toUpperCase()} ·{" "}
								{experienceLabel(round.candidate.years)}
							</p>
						</div>
						<div role="status">
							<InterviewStatus state={round.state} />
						</div>
					</header>
					<div className="grid items-start gap-4 lg:grid-cols-2">
						<ScheduleCard round={round} />
						<Card>
							<CardHeader>
								<CardTitle>Attendance</CardTitle>
							</CardHeader>
							<CardContent className="flex flex-col items-start gap-4">
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
							</CardContent>
						</Card>
					</div>
				</>
			)}
		</section>
	);
}
