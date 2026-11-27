import {
	type DirectorResult,
	directorScorecardsSchema,
} from "@studio/contracts";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { ChevronDown } from "lucide-react";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
	SheetDescription,
	SheetHeader,
	SheetTitle,
} from "@/components/ui/sheet";
import {
	accessDenied,
	interviewRequest,
	retryInterviewRead,
} from "../interviews/api";
import {
	AssessmentVersionCard,
	AssessmentVersionHistory,
} from "../interviews/assessment-versions";
import {
	formatDate,
	InterviewAlert,
	InterviewLoading,
} from "../interviews/display";
import { decisionLabels } from "../interviews/scorecard";

export function DirectorScorecards({
	candidacy,
	path,
}: {
	candidacy: DirectorResult;
	path: string;
}) {
	const [page, setPage] = useState(1);
	const [expanded, setExpanded] = useState<string>();
	const { drive, id, name } = candidacy;
	const request = useQuery({
		queryKey: ["director-scorecards", drive.id, id, page],
		queryFn: ({ signal }) =>
			interviewRequest(
				`${path}/candidacies/${drive.id}/${id}/scorecards?page=${page}`,
				directorScorecardsSchema,
				{ signal },
			),
		placeholderData: keepPreviousData,
		refetchOnWindowFocus: "always",
		retry: retryInterviewRead,
	});
	const list = accessDenied(request.error) ? undefined : request.data;

	return (
		<>
			<SheetHeader className="gap-1.5 border-b p-4 pr-12 sm:p-6 sm:pr-14">
				<SheetTitle className="text-2xl tracking-tight [overflow-wrap:anywhere]">
					{name}
				</SheetTitle>
				<SheetDescription className="[overflow-wrap:anywhere]">
					{drive.title} · Submitted scorecards
				</SheetDescription>
			</SheetHeader>
			<div className="min-h-0 flex-1 space-y-3 overflow-y-auto overscroll-contain p-4 sm:p-6">
				{request.error && <InterviewAlert error={request.error} />}
				{request.isPending && <InterviewLoading />}
				{list && (
					<>
						{list.items.length ? (
							<ul className="space-y-3" aria-busy={request.isPlaceholderData}>
								{list.items.map((item) => {
									const title = `${item.round.toUpperCase()} · Attempt ${item.attempt}`;
									const open = expanded === item.roundId;
									const key = ["director-scorecard", item.roundId];
									const roundPath = `${path}/rounds/${item.roundId}`;
									return (
										<li key={item.roundId} className="rounded-lg border">
											<button
												type="button"
												aria-expanded={open}
												aria-label={`View ${title}`}
												className="flex w-full items-center justify-between gap-2 rounded-lg p-3 text-left hover:bg-muted"
												onClick={() =>
													setExpanded(open ? undefined : item.roundId)
												}
											>
												<span>
													<span className="block font-semibold">{title}</span>
													<time
														dateTime={item.submittedAt}
														className="text-xs text-muted-foreground"
													>
														{formatDate(item.submittedAt, "UTC")} (UTC)
													</time>
												</span>
												<span className="flex flex-wrap items-center justify-end gap-2">
													<Badge variant="muted">
														{decisionLabels[item.decision]}
													</Badge>
													<ChevronDown
														className={`size-4 shrink-0 text-muted-foreground ${open ? "rotate-180" : ""}`}
														aria-hidden="true"
													/>
												</span>
											</button>
											{open && (
												<div className="space-y-3 border-t p-3">
													<AssessmentVersionCard
														path={roundPath}
														queryKey={key}
														versionId={item.versionId}
													/>
													<AssessmentVersionHistory
														path={roundPath}
														queryKey={key}
														headId={item.versionId}
													/>
												</div>
											)}
										</li>
									);
								})}
							</ul>
						) : (
							<p className="text-sm text-muted-foreground">
								No submitted scorecards on this page.
							</p>
						)}
						{(page > 1 || list.hasNext) && (
							<nav
								aria-label="Submitted scorecard pages"
								className="flex items-center justify-end gap-3 text-sm"
							>
								<Button
									variant="outline"
									size="sm"
									disabled={page === 1 || request.isPlaceholderData}
									onClick={() => setPage(page - 1)}
								>
									Previous
								</Button>
								<span>Page {list.page}</span>
								<Button
									variant="outline"
									size="sm"
									disabled={!list.hasNext || request.isPlaceholderData}
									onClick={() => setPage(page + 1)}
								>
									Next
								</Button>
							</nav>
						)}
					</>
				)}
			</div>
		</>
	);
}
