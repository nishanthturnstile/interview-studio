import type {
	AssignedInterview,
	InterviewConflict,
	InterviewSchedule,
} from "@studio/contracts";
import { CalendarDays, CircleAlert, Clock3, MapPin, Video } from "lucide-react";
import type { ReactNode } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
	Empty,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import { interviewMessage } from "./api";

export const stateNames = {
	scheduled: "Scheduled",
	active: "Active",
	awaiting_feedback: "Awaiting feedback",
	cancelled: "Cancelled",
	no_show: "No-show",
	withdrawn: "Withdrawn",
};

export function InterviewStatus({ state }: { state: keyof typeof stateNames }) {
	return (
		<Badge
			variant={
				state === "active"
					? "success"
					: state === "scheduled"
						? "info"
						: state === "awaiting_feedback"
							? "warning"
							: "muted"
			}
		>
			{stateNames[state]}
		</Badge>
	);
}

export function formatDate(value: string, timeZone: string) {
	return new Intl.DateTimeFormat("en-GB", {
		timeZone,
		dateStyle: "medium",
	}).format(new Date(value));
}

export function formatClock(value: string, timeZone: string) {
	return new Intl.DateTimeFormat("en-GB", {
		timeZone,
		hour: "2-digit",
		minute: "2-digit",
		hourCycle: "h23",
	}).format(new Date(value));
}

export function scheduleLabel(start: string, end: string | null, zone: string) {
	const firstDate = formatDate(start, zone);
	const first = `${firstDate}, ${formatClock(start, zone)}`;
	if (!end) return `${first} onward (${zone})`;
	const endDate = formatDate(end, zone);
	const finish = `${endDate === firstDate ? "" : `${endDate}, `}${formatClock(end, zone)}`;
	return `${first} – ${finish} (${zone})`;
}

export function localSlot(round: InterviewSchedule) {
	const parts = new Intl.DateTimeFormat("en-CA", {
		timeZone: round.timeZone,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		hourCycle: "h23",
		timeZoneName: "longOffset",
	}).formatToParts(new Date(round.start));
	const part = (key: string) =>
		parts.find(({ type }) => type === key)?.value ?? "";
	return {
		date: `${part("year").padStart(4, "0")}-${part("month")}-${part("day")}`,
		time: `${part("hour")}:${part("minute")}`,
		duration: String(round.duration),
		offset: part("timeZoneName").replace(/^GMT/, "") || "+00:00",
	};
}

export const experienceLabel = (years: number | null) =>
	years === null
		? "Experience unknown"
		: `${years} ${years === 1 ? "year" : "years"} of experience`;

export function InterviewAlert({ error }: { error: unknown }) {
	return (
		<Alert variant="destructive" role="alert">
			<CircleAlert />
			<AlertTitle>{interviewMessage(error)}</AlertTitle>
		</Alert>
	);
}

export function ConflictWarning({
	conflicts,
}: {
	conflicts: InterviewConflict[];
}) {
	return (
		<Alert variant="warning" role="alert">
			<CircleAlert />
			<AlertTitle>Overlapping interviews</AlertTitle>
			<AlertDescription>
				<ul className="flex flex-col gap-2">
					{conflicts.map((conflict) => (
						<li key={conflict.id}>
							<span className="font-semibold">
								{conflict.resources
									.map((value) =>
										value === "panelist" ? "Panelist" : "Candidate",
									)
									.join(" and ")}{" "}
								· {conflict.drive.title}
							</span>
							<br />
							{scheduleLabel(conflict.start, conflict.end, conflict.timeZone)}
						</li>
					))}
				</ul>
			</AlertDescription>
		</Alert>
	);
}

export function InterviewEmpty({
	title,
	description,
}: {
	title: string;
	description: string;
}) {
	return (
		<Empty className="min-h-54 border bg-card">
			<EmptyHeader>
				<EmptyMedia variant="icon">
					<CalendarDays />
				</EmptyMedia>
				<EmptyTitle>{title}</EmptyTitle>
				<EmptyDescription>{description}</EmptyDescription>
			</EmptyHeader>
		</Empty>
	);
}

export function InterviewLoading() {
	return (
		<div aria-busy="true" role="status" className="flex flex-col gap-3">
			<span className="sr-only">Loading interviews…</span>
			<Skeleton className="h-12 w-full" />
			<Skeleton className="h-12 w-full" />
			<Skeleton className="h-12 w-full" />
		</div>
	);
}

export function ScheduleCard({
	round,
	title = "Interview details",
	children,
}: {
	round: InterviewSchedule;
	title?: string;
	children?: ReactNode;
}) {
	const meeting = round.meeting;
	return (
		<Card>
			<CardHeader>
				<CardTitle>{title}</CardTitle>
			</CardHeader>
			<CardContent className="flex flex-col gap-4">
				<div className="flex items-start gap-3">
					<CalendarDays
						className="mt-0.5 size-4 shrink-0 text-muted-foreground"
						aria-hidden="true"
					/>
					<div>
						<div className="font-medium">
							{scheduleLabel(round.start, round.end, round.timeZone)}
						</div>
						<div className="mt-1 flex items-center gap-1.5 text-sm text-muted-foreground">
							<Clock3 className="size-3.5" aria-hidden="true" />
							{round.duration} minutes
						</div>
					</div>
				</div>
				{meeting.mode === "virtual" ? (
					meeting.teamsUrl ? (
						<a
							href={meeting.teamsUrl}
							target="_blank"
							rel="noopener noreferrer"
							className={buttonVariants({
								variant: "outline",
								className: "self-start",
							})}
						>
							<Video data-icon="inline-start" />
							Open Teams meeting
						</a>
					) : (
						<p className="flex items-center gap-3 text-sm text-muted-foreground">
							<Video className="size-4" aria-hidden="true" />
							Teams link pending
						</p>
					)
				) : (
					<p className="flex items-start gap-3 text-sm [overflow-wrap:anywhere]">
						<MapPin
							className="mt-0.5 size-4 shrink-0 text-muted-foreground"
							aria-hidden="true"
						/>
						<span>{meeting.room}</span>
					</p>
				)}
				{children}
			</CardContent>
		</Card>
	);
}

export function AttendanceSummary({ round }: { round: AssignedInterview }) {
	const { attendance } = round;
	return (
		<div className="flex flex-col gap-1 text-sm">
			<p className="flex items-center gap-2 font-medium">
				{attendance.connected && (
					<span
						className="size-2 rounded-full bg-success-foreground"
						aria-hidden="true"
					/>
				)}
				{attendance.connected
					? "Candidate connected"
					: round.state === "scheduled"
						? "Waiting for candidate"
						: attendance.confirmedAt
							? "Candidate attended"
							: "Candidate attendance unconfirmed"}
			</p>
			{attendance.lastSeenAt && (
				<p className="text-muted-foreground">
					Last seen at {formatClock(attendance.lastSeenAt, round.timeZone)} (
					{round.timeZone})
				</p>
			)}
		</div>
	);
}
