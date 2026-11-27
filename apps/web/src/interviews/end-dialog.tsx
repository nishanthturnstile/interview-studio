import { Square } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogClose,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "@/components/ui/dialog";
import { InterviewAlert } from "./display";

export function EndInterviewDialog({
	open,
	setOpen,
	pending,
	error,
	onEnd,
	candidate = false,
	preparing = false,
	ready = true,
	triggerDisabled = false,
	onRetryPrepare,
	actions,
}: {
	open: boolean;
	setOpen: (open: boolean) => void;
	pending: boolean;
	error: unknown;
	onEnd: () => void;
	candidate?: boolean;
	preparing?: boolean;
	ready?: boolean;
	triggerDisabled?: boolean;
	onRetryPrepare?: () => void;
	actions?: ReactNode;
}) {
	return (
		<Dialog
			open={open}
			onOpenChange={(value) => {
				if (!pending) setOpen(value);
			}}
		>
			<DialogTrigger
				render={
					<Button
						variant={candidate ? "outline" : "destructive"}
						disabled={triggerDisabled}
					/>
				}
			>
				{!candidate && <Square aria-hidden="true" />}
				End interview
			</DialogTrigger>
			<DialogContent showCloseButton={false}>
				<DialogHeader>
					<DialogTitle>End this interview?</DialogTitle>
					<DialogDescription>
						{candidate
							? "This closes the interview for both participants and ends your access to this round."
							: "This closes access for the candidate and moves the round to Awaiting feedback."}
					</DialogDescription>
				</DialogHeader>
				{preparing && (
					<p role="status" className="text-sm text-muted-foreground">
						Saving and checking workspace…
					</p>
				)}
				{error !== undefined && <InterviewAlert error={error} />}
				{error !== undefined && !ready && !preparing && onRetryPrepare && (
					<Button variant="outline" onClick={onRetryPrepare}>
						Retry check
					</Button>
				)}
				{actions}
				<DialogFooter>
					<DialogClose render={<Button variant="outline" disabled={pending} />}>
						Keep interview open
					</DialogClose>
					<Button
						variant="destructive"
						disabled={pending || !ready}
						onClick={onEnd}
					>
						{pending ? "Ending…" : "End interview"}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
