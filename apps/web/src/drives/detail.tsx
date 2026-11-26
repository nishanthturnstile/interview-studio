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
import { ArrowLeft } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
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
									set.round === round.round && set.revision > round.revision,
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

	function saveSkills(set: SkillSet) {
		setOverview(
			(current) =>
				current && {
					...current,
					skills: current.skills.map((round) =>
						round.round === set.round ? set : round,
					),
				},
		);
	}

	return (
		<section className="mx-auto flex w-full min-w-0 max-w-7xl flex-col gap-6 px-4 py-6 sm:px-8 sm:py-9">
			<Link
				to="/staff/drives"
				className="inline-flex items-center gap-2 self-start text-sm font-medium text-muted-foreground underline-offset-4 hover:underline"
			>
				<ArrowLeft className="size-4" aria-hidden="true" />
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
					<header className="flex min-w-0 flex-col gap-4">
						<h1 className="font-display text-4xl leading-tight tracking-tight [overflow-wrap:anywhere] sm:text-5xl">
							{overview.name}
						</h1>
						<dl className="grid grid-cols-2 gap-y-3 border-y py-3 sm:grid-cols-4 sm:py-4">
							{metrics.map(([key, label]) => (
								<div
									className="flex min-w-0 flex-wrap items-baseline gap-x-2 px-3 odd:border-r sm:border-r sm:px-4 sm:last:border-0"
									key={key}
								>
									<dt className="text-sm text-muted-foreground">{label}</dt>
									<dd className="text-xl font-semibold tabular-nums">
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
						className="flex min-w-0 flex-col gap-4 border-t pt-5"
						aria-labelledby="scorecard-skills"
					>
						<h2
							id="scorecard-skills"
							className="scroll-mt-6 text-2xl font-semibold"
						>
							Scorecard skills
						</h2>
						<div className="grid gap-4 lg:grid-cols-[repeat(2,minmax(0,1fr))] lg:gap-5">
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
