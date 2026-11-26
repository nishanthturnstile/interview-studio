import {
	canViewDrives,
	type DriveOverview,
	driveOverviewSchema,
	type SkillSet,
} from "@studio/contracts";
import {
	getRouteApi,
	Link,
	Navigate,
	useBlocker,
} from "@tanstack/react-router";
import { ChevronLeft } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, AlertTitle } from "@/components/ui/alert";
import { Button, buttonVariants } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { requestMessage, useDriveRequest } from "./api";
import { Intake } from "./intake";
import { Skills } from "./skills";

const metrics = [
	["resumes", "Resumes"],
	["drafts", "Drafts"],
	["confirmed", "Confirmed"],
	["duplicates", "Duplicates"],
] as const;

function DriveDetail({ driveId, hr }: { driveId: string; hr: boolean }) {
	const request = useDriveRequest();
	const [overview, setOverview] = useState<DriveOverview>();
	const [error, setError] = useState("");
	const dirty = useRef(new Set<string>());
	const onDirty = useCallback((key: string, value: boolean) => {
		if (value) dirty.current.add(key);
		else dirty.current.delete(key);
	}, []);
	const blocker = useBlocker({
		shouldBlockFn: () => dirty.current.size > 0,
		enableBeforeUnload: () => dirty.current.size > 0,
		withResolver: true,
	});
	const sequence = useRef(0);
	const load = useCallback(
		async (signal?: AbortSignal) => {
			const attempt = ++sequence.current;
			try {
				const next = await request(`/${driveId}`, driveOverviewSchema, {
					signal,
				});
				if (attempt !== sequence.current) return;
				setOverview((current) => ({
					...next,
					skills: next.skills.map(
						(round) =>
							current?.skills.find(
								(set) =>
									set.round === round.round && set.revision >= round.revision,
							) ?? round,
					),
				}));
				setError("");
			} catch (error) {
				if (!signal?.aborted && attempt === sequence.current)
					setError(requestMessage(error));
			}
		},
		[driveId, request],
	);
	useEffect(() => {
		const controller = new AbortController();
		void load(controller.signal);
		return () => controller.abort();
	}, [load]);
	const refresh = useCallback(() => {
		void load();
	}, [load]);

	const saveSkills = useCallback((set: SkillSet) => {
		setOverview(
			(current) =>
				current && {
					...current,
					skills: current.skills.map((round) =>
						round.round === set.round ? set : round,
					),
				},
		);
	}, []);

	return (
		<section className="@container/drive mx-auto flex w-full min-w-0 max-w-[90rem] flex-col gap-6 px-4 py-4 sm:gap-7 sm:px-7 sm:py-6 xl:px-9">
			<Link
				to="/staff/drives"
				className={buttonVariants({
					variant: "ghost",
					size: "sm",
					className: "-ml-2.5 self-start text-muted-foreground",
				})}
			>
				<ChevronLeft aria-hidden="true" />
				Drives
			</Link>
			{error && (
				<Alert variant="destructive">
					<AlertTitle>{error}</AlertTitle>
					<Button variant="outline" size="sm" onClick={refresh}>
						Try again
					</Button>
				</Alert>
			)}
			{!error && !overview && (
				<p role="status" className="text-muted-foreground">
					Loading drive…
				</p>
			)}
			{overview && (
				<>
					<header className="flex min-w-0 flex-col gap-4 border-b pb-5 @min-[63rem]/drive:flex-row @min-[63rem]/drive:items-end @min-[63rem]/drive:justify-between">
						<h1 className="min-w-0 font-display text-3xl leading-tight tracking-tight text-balance [overflow-wrap:anywhere] sm:text-4xl @min-[63rem]/drive:text-5xl">
							{overview.name}
						</h1>
						<dl className="grid grid-cols-4 gap-1.5 @min-[63rem]/drive:w-[25rem] @min-[63rem]/drive:shrink-0">
							{metrics.map(([key, label]) => (
								<div
									className="flex min-w-0 flex-col gap-0.5 border-l pl-2 first:border-l-0 first:pl-0 sm:pl-4"
									key={key}
								>
									<dt className="text-xs text-muted-foreground">{label}</dt>
									<dd className="text-xl leading-tight font-semibold tabular-nums">
										{overview.counts[key]}
									</dd>
								</div>
							))}
						</dl>
					</header>
					{hr && (
						<Intake
							driveId={driveId}
							request={request}
							onOverviewChange={refresh}
							onDirty={onDirty}
						/>
					)}
					<section
						className="flex min-w-0 flex-col gap-3 border-t pt-5"
						aria-labelledby="scorecard-skills"
					>
						<h2
							id="scorecard-skills"
							className="scroll-mt-6 text-xl font-semibold"
						>
							Scorecard skills
						</h2>
						<div className="grid gap-4 @min-[45rem]/drive:grid-cols-2">
							{overview.skills.map((set) => (
								<Skills
									key={set.round}
									driveId={driveId}
									set={set}
									hr={hr}
									request={request}
									onSaved={saveSkills}
									onDirty={onDirty}
								/>
							))}
						</div>
					</section>
				</>
			)}
			{blocker.status === "blocked" && (
				<Dialog
					open
					onOpenChange={(open) => {
						if (!open) blocker.reset();
					}}
				>
					<DialogContent>
						<DialogHeader>
							<DialogTitle>Leave this drive?</DialogTitle>
							<DialogDescription>
								You have unsaved changes in this drive.
							</DialogDescription>
						</DialogHeader>
						<DialogFooter>
							<Button variant="outline" onClick={blocker.reset}>
								Keep editing
							</Button>
							<Button variant="destructive" onClick={blocker.proceed}>
								Discard edits
							</Button>
						</DialogFooter>
					</DialogContent>
				</Dialog>
			)}
		</section>
	);
}

export function StaffDriveDetail() {
	const { id, role } = getRouteApi("/staff").useLoaderData();
	const { driveId } = getRouteApi("/staff/drives/$driveId").useParams();
	if (!canViewDrives(role)) return <Navigate to="/staff" replace />;
	return (
		<DriveDetail
			key={`${id}:${role}:${driveId}`}
			driveId={driveId}
			hr={role === "hr"}
		/>
	);
}
