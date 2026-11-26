import type { DocumentStatus } from "@studio/contracts";
import { Download, FileText } from "lucide-react";
import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { originalUrl } from "./api";

export function isPending(document: DocumentStatus) {
	return (
		document.uploadState === "pending" ||
		(document.uploadState === "stored" &&
			(document.parseState === "queued" ||
				document.parseState === "processing"))
	);
}

export function documentLabel(document: DocumentStatus) {
	if (document.uploadState === "pending") return "Receiving";
	if (document.uploadState !== "stored") return "Upload failed";
	switch (document.parseState) {
		case "processing":
			return document.parseAttempts > 1
				? `Extracting · attempt ${document.parseAttempts}`
				: "Extracting";
		case "succeeded":
			return document.usedOcr ? "Text extracted with OCR" : "Text extracted";
		case "needs_manual_review":
			return "Needs manual review";
		case "queued":
			return document.parseAttempts ? "Waiting to retry extraction" : "Queued";
		default:
			return "Stored";
	}
}

const failureMessage = {
	scan_only: "No readable text was found.",
	invalid_document: "The document contents could not be read.",
	resource_limit: "The document exceeded an extraction limit.",
	infrastructure_exhausted: "Extraction could not finish after retrying.",
};

export function DocumentHeader({
	document,
	driveId,
	preview,
	showDownload = true,
	compact = false,
}: {
	document: DocumentStatus;
	driveId: string;
	preview?: ReactNode;
	showDownload?: boolean;
	compact?: boolean;
}) {
	const status = (
		<Badge
			role="status"
			variant={
				document.parseState === "succeeded"
					? "success"
					: document.parseFailure
						? "warning"
						: "secondary"
			}
		>
			{documentLabel(document)}
		</Badge>
	);
	return (
		<div className="flex min-w-0 flex-col gap-2">
			<div className="flex flex-wrap items-center justify-between gap-3">
				{compact ? (
					status
				) : (
					<div className="flex min-w-0 items-start gap-3">
						<span className="grid size-9 shrink-0 place-items-center rounded-md bg-secondary text-secondary-foreground">
							<FileText className="size-4" aria-hidden="true" />
						</span>
						<div className="min-w-0">
							<h3 className="font-semibold [overflow-wrap:anywhere]">
								{document.filename}
							</h3>
							<div className="mt-1">{status}</div>
						</div>
					</div>
				)}
				{document.uploadState === "stored" && (preview || showDownload) && (
					<div className="flex flex-wrap items-center gap-2">
						{preview}
						{showDownload && (
							<a
								href={originalUrl(driveId, document.id)}
								className={buttonVariants({ size: "sm", variant: "outline" })}
								aria-label={`Download original ${document.filename}`}
							>
								<Download aria-hidden="true" />
								Download original
							</a>
						)}
					</div>
				)}
			</div>
			{document.parseFailure && document.uploadState === "stored" && (
				<p className="text-sm text-muted-foreground">
					{failureMessage[document.parseFailure]}
				</p>
			)}
		</div>
	);
}
