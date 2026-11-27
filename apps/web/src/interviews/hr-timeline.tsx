import type { InterviewWorkspaceItem } from "@studio/contracts";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { accessDenied } from "./api";
import { HrScorecard } from "./assessment";
import {
	InterviewAlert,
	InterviewLoading,
	InterviewStatus,
	scheduleLabel,
} from "./display";
import { InterviewSheetForm } from "./hr-actions";
import { hrTimelineQuery } from "./hr-queries";
import { decisionLabels } from "./scorecard";

export function CandidacyTimeline({ item }: { item: InterviewWorkspaceItem }) {
	const [page, setPage] = useState(1);
	const [scorecard, setScorecard] = useState<string>();
	const request = useQuery(hrTimelineQuery(item.drive.id, item.id, page));
	const timeline = accessDenied(request.error) ? undefined : request.data;
	return (
		<InterviewSheetForm
			title={item.name}
			description={`${item.drive.title} · ${item.outcome ? "Interview history" : "Interview timeline"}`}
			footer={null}
		>
			{request.error && <InterviewAlert error={request.error} />}
			{request.isPending && <InterviewLoading />}
			{timeline && (
				<>
					{timeline.withdrawal && (
						<section className="rounded-lg border bg-card p-4 text-sm">
							<h3 className="font-semibold">Withdrawn</h3>
							<p className="text-muted-foreground">
								{new Date(timeline.withdrawal.at).toLocaleDateString()}
							</p>
							<p className="mt-2 whitespace-pre-wrap [overflow-wrap:anywhere]">
								{timeline.withdrawal.reason}
							</p>
						</section>
					)}
					{timeline.items.length ? (
						<ol
							className="divide-y rounded-lg border bg-card"
							aria-label="Interview attempts"
						>
							{timeline.items.map((round) => (
								<li key={round.id} className="space-y-2 px-4 py-3">
									<div className="flex flex-wrap items-center justify-between gap-2">
										<h3 className="font-semibold">
											{round.level.toUpperCase()} · Attempt {round.attempt}
										</h3>
										<div className="flex flex-wrap gap-1.5">
											<InterviewStatus state={round.state} />
											{round.decision && (
												<Badge variant="muted">
													{decisionLabels[round.decision]}
												</Badge>
											)}
											{round.superseded && (
												<Badge variant="muted">Superseded</Badge>
											)}
											{round.reviewAffectsRound && (
												<Badge variant="warning">Pending HR review</Badge>
											)}
										</div>
									</div>
									<p className="text-sm text-muted-foreground [overflow-wrap:anywhere]">
										{scheduleLabel(round.start, round.end, round.timeZone)} ·{" "}
										{round.panelist.name}
									</p>
									{round.reason && (
										<p className="text-sm whitespace-pre-wrap [overflow-wrap:anywhere]">
											{round.reason}
										</p>
									)}
									{round.decision && (
										<Button
											variant="outline"
											size="sm"
											aria-expanded={scorecard === round.id}
											onClick={() =>
												setScorecard(
													scorecard === round.id ? undefined : round.id,
												)
											}
										>
											{scorecard === round.id ? "Hide" : "View"}{" "}
											{round.level.toUpperCase()} scorecard
										</Button>
									)}
									{scorecard === round.id && <HrScorecard roundId={round.id} />}
								</li>
							))}
						</ol>
					) : (
						<p className="text-sm text-muted-foreground">
							No interview attempts recorded.
						</p>
					)}
					{(page > 1 || timeline.hasNext) && (
						<nav
							aria-label="Interview history pages"
							className="flex items-center justify-between gap-2"
						>
							<Button
								variant="outline"
								size="sm"
								disabled={page === 1}
								onClick={() => {
									setScorecard(undefined);
									setPage(page - 1);
								}}
							>
								Previous
							</Button>
							<span className="text-sm">Page {page}</span>
							<Button
								variant="outline"
								size="sm"
								disabled={!timeline.hasNext}
								onClick={() => {
									setScorecard(undefined);
									setPage(page + 1);
								}}
							>
								Next
							</Button>
						</nav>
					)}
				</>
			)}
		</InterviewSheetForm>
	);
}
