import { useBlocker } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";

export function AssessmentNavigation({
	dirty,
	saving,
}: {
	dirty: boolean;
	saving: boolean;
}) {
	const blocker = useBlocker({
		shouldBlockFn: () => dirty || saving,
		enableBeforeUnload: dirty || saving,
		withResolver: true,
	});
	if (blocker.status !== "blocked") return null;

	return (
		<Dialog
			open
			onOpenChange={(open) => {
				if (!open) blocker.reset();
			}}
		>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>
						{saving ? "Saving assessment" : "Leave with unsaved changes?"}
					</DialogTitle>
					<DialogDescription>
						{saving
							? "Wait for the current action to finish before leaving."
							: "Keep editing to save your work, or leave and discard your unsaved changes."}
					</DialogDescription>
				</DialogHeader>
				<DialogFooter>
					<Button variant="outline" onClick={blocker.reset}>
						Keep editing
					</Button>
					{!saving && (
						<Button variant="destructive" onClick={blocker.proceed}>
							Discard changes
						</Button>
					)}
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
