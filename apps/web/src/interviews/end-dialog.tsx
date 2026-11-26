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
}: {
	open: boolean;
	setOpen: (open: boolean) => void;
	pending: boolean;
	error: unknown;
	onEnd: () => void;
	candidate?: boolean;
}) {
	return (
		<Dialog
			open={open}
			onOpenChange={(value) => {
				if (!pending) setOpen(value);
			}}
		>
			<DialogTrigger render={<Button variant="outline" />}>
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
				{error !== undefined && <InterviewAlert error={error} />}
				<DialogFooter>
					<DialogClose render={<Button variant="outline" disabled={pending} />}>
						Keep interview open
					</DialogClose>
					<Button variant="destructive" disabled={pending} onClick={onEnd}>
						{pending ? "Ending…" : "End interview"}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
