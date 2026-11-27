import {
	assessmentVersionDetailSchema,
	assessmentVersionListSchema,
} from "@studio/contracts";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { accessDenied, interviewRequest, retryInterviewRead } from "./api";
import { InterviewAlert, InterviewLoading } from "./display";
import { decisionLabels, SubmittedScorecard } from "./scorecard";

export function AssessmentVersionCard({
	path,
	queryKey,
	versionId,
}: {
	path: string;
	queryKey: string[];
	versionId: string;
}) {
	const request = useQuery({
		queryKey: [...queryKey, "version", versionId],
		queryFn: ({ signal }) =>
			interviewRequest(
				`${path}/versions/${versionId}`,
				assessmentVersionDetailSchema,
				{ signal },
			),
		refetchOnWindowFocus: "always",
		retry: retryInterviewRead,
	});
	const detail = accessDenied(request.error) ? undefined : request.data;
	return (
		<div className="space-y-3">
			{request.error && <InterviewAlert error={request.error} />}
			{detail ? (
				<>
					<SubmittedScorecard {...detail} />
					{detail.l1Handoff && (
						<details className="space-y-2 rounded-md border p-3">
							<summary className="cursor-pointer font-medium">
								L1 handoff used for this version
							</summary>
							<SubmittedScorecard {...detail.l1Handoff} />
						</details>
					)}
				</>
			) : (
				request.isPending && <InterviewLoading />
			)}
		</div>
	);
}

export function AssessmentVersionHistory({
	path,
	queryKey,
	headId,
}: {
	path: string;
	queryKey: string[];
	headId: string;
}) {
	const [open, setOpen] = useState(false);
	const [page, setPage] = useState(1);
	const [selected, setSelected] = useState<string>();
	const request = useQuery({
		queryKey: [...queryKey, "versions", headId, page],
		queryFn: ({ signal }) =>
			interviewRequest(
				`${path}/versions?page=${page}`,
				assessmentVersionListSchema,
				{ signal },
			),
		enabled: open,
		placeholderData: keepPreviousData,
		refetchOnWindowFocus: "always",
		retry: retryInterviewRead,
	});
	const list = accessDenied(request.error) ? undefined : request.data;
	const previousDisabled = page === 1 || request.isPlaceholderData;
	const nextDisabled = !list?.hasNext || request.isPlaceholderData;
	return (
		<details
			className="space-y-3 rounded-md border p-3"
			onToggle={(event) => setOpen(event.currentTarget.open)}
		>
			<summary className="cursor-pointer font-medium">Version history</summary>
			{open && (
				<>
					{request.error && <InterviewAlert error={request.error} />}
					{list ? (
						<>
							<ul className="space-y-2" aria-busy={request.isPlaceholderData}>
								{list.items.map((version) => (
									<li key={version.id} className="text-sm">
										<Button
											type="button"
											size="sm"
											variant="outline"
											aria-expanded={selected === version.id}
											onClick={() =>
												setSelected(
													selected === version.id ? undefined : version.id,
												)
											}
										>
											Version {version.version} ·{" "}
											{decisionLabels[version.decision]}
										</Button>
										{selected === version.id && (
											<div className="pt-2">
												<AssessmentVersionCard
													path={path}
													queryKey={queryKey}
													versionId={version.id}
												/>
											</div>
										)}
									</li>
								))}
							</ul>
							{(list.hasNext || page > 1) && (
								<nav
									aria-label="Scorecard history pages"
									className="flex flex-wrap items-center gap-2 text-sm"
								>
									<Button
										type="button"
										size="sm"
										variant="outline"
										aria-disabled={previousDisabled}
										className="aria-disabled:opacity-50"
										onClick={() => {
											if (!previousDisabled) setPage(page - 1);
										}}
									>
										Previous
									</Button>
									<span aria-live="polite">Page {list.page}</span>
									<Button
										type="button"
										size="sm"
										variant="outline"
										aria-disabled={nextDisabled}
										className="aria-disabled:opacity-50"
										onClick={() => {
											if (!nextDisabled) setPage(page + 1);
										}}
									>
										Next
									</Button>
								</nav>
							)}
						</>
					) : (
						request.isPending && <InterviewLoading />
					)}
				</>
			)}
		</details>
	);
}
