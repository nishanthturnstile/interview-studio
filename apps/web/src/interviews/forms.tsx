import { Combobox } from "@base-ui/react/combobox";
import {
	type InterviewMeeting,
	type InterviewPanelist,
	interviewPanelistsSchema,
	interviewSlotPreviewSchema,
	interviewSlotSchema,
} from "@studio/contracts";
import { Check, ChevronsUpDown } from "lucide-react";
import { useId, useState } from "react";
import { Button } from "@/components/ui/button";
import {
	Field,
	FieldDescription,
	FieldGroup,
	FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
	InputGroup,
	InputGroupAddon,
	InputGroupInput,
} from "@/components/ui/input-group";
import {
	Select,
	SelectContent,
	SelectGroup,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { InterviewRequestError, useInterviewResource } from "./api";
import { InterviewAlert, scheduleLabel } from "./display";

export function PanelistPicker({
	value,
	onChange,
}: {
	value: InterviewPanelist | null;
	onChange: (value: InterviewPanelist | null) => void;
}) {
	const id = useId();
	const [search, setSearch] = useState("");
	const [unselected, setUnselected] = useState(false);
	const request = useInterviewResource(
		`/staff/interviews/panelists?search=${encodeURIComponent(search.trim())}`,
		interviewPanelistsSchema,
		{ delay: 180 },
	);
	return (
		<Field>
			<FieldLabel htmlFor={id}>Panelist</FieldLabel>
			<Combobox.Root
				items={request.data ?? []}
				filter={null}
				value={value}
				openOnInputClick
				itemToStringLabel={(item) => item.name}
				isItemEqualToValue={(a, b) => a.id === b.id}
				onValueChange={(panelist) => {
					onChange(panelist);
					setUnselected(false);
				}}
				onInputValueChange={(text, event) => {
					if (event.reason === "input-change") {
						setSearch(text);
						setUnselected(Boolean(value && text !== value.name));
					}
				}}
				onOpenChange={(open) => {
					if (!open) {
						setSearch("");
						setUnselected(false);
					}
				}}
			>
				<InputGroup className="h-10">
					<Combobox.Input
						id={id}
						aria-required="true"
						placeholder="Search by name or work email"
						render={<InputGroupInput />}
					/>
					<InputGroupAddon align="inline-end">
						<Combobox.Trigger
							aria-label="Show panelists"
							render={<Button variant="ghost" size="icon-sm" />}
						>
							<ChevronsUpDown />
						</Combobox.Trigger>
					</InputGroupAddon>
				</InputGroup>
				<Combobox.Portal>
					<Combobox.Positioner
						sideOffset={4}
						className="z-60 w-(--anchor-width)"
					>
						<Combobox.Popup className="max-h-(--available-height) overflow-y-auto rounded-md border bg-popover p-1 text-sm text-popover-foreground shadow-md">
							<Combobox.Empty className="px-3 py-2 text-muted-foreground">
								{request.loading
									? "Searching panelists…"
									: request.error
										? "Couldn’t load panelists."
										: search
											? "No matching panelists."
											: "A panelist must register and verify their work email."}
							</Combobox.Empty>
							<Combobox.List>
								{(panelist: InterviewPanelist) => (
									<Combobox.Item
										key={panelist.id}
										value={panelist}
										className="flex cursor-default items-center justify-between gap-2 rounded px-3 py-2 outline-none data-highlighted:bg-accent data-highlighted:text-accent-foreground"
									>
										<span className="min-w-0">
											<span className="block truncate font-medium">
												{panelist.name}
											</span>
											<span className="block truncate text-xs text-muted-foreground">
												{panelist.email}
											</span>
										</span>
										<Combobox.ItemIndicator>
											<Check className="size-4" aria-hidden="true" />
										</Combobox.ItemIndicator>
									</Combobox.Item>
								)}
							</Combobox.List>
						</Combobox.Popup>
					</Combobox.Positioner>
				</Combobox.Portal>
			</Combobox.Root>
			{value && !unselected && (
				<FieldDescription>{value.email}</FieldDescription>
			)}
			{!request.loading &&
				!request.error &&
				!search &&
				request.data?.length === 0 && (
					<FieldDescription>
						A panelist must register and verify their work email before you can
						book.
					</FieldDescription>
				)}
			{request.error !== undefined && (
				<div className="flex items-center gap-2">
					<InterviewAlert error={request.error} />
					<Button variant="outline" size="sm" onClick={request.refresh}>
						Retry
					</Button>
				</div>
			)}
		</Field>
	);
}

export type SlotFieldsValue = {
	date: string;
	time: string;
	duration: string;
	offset?: string;
};

export function readSlot(value: SlotFieldsValue) {
	return interviewSlotSchema.safeParse({
		...value,
		duration: Number(value.duration),
	}).data;
}

export function useSlotPreview(
	value: SlotFieldsValue | null,
	timeZone: string,
) {
	const slot = value ? readSlot(value) : undefined;
	const query =
		slot &&
		new URLSearchParams({
			timeZone,
			date: slot.date,
			time: slot.time,
			duration: String(slot.duration),
			...(slot.offset ? { offset: slot.offset } : {}),
		});
	const resource = useInterviewResource(
		query ? `/staff/settings/interviews/slot?${query}` : null,
		interviewSlotPreviewSchema,
		{ delay: 240 },
	);
	return { ...resource, slot };
}

export function SlotFields({
	value,
	timeZone,
	onChange,
	preview: resource,
}: {
	value: SlotFieldsValue;
	timeZone: string;
	onChange: (next: SlotFieldsValue) => void;
	preview: ReturnType<typeof useSlotPreview>;
}) {
	const id = useId();
	const problem =
		resource.error instanceof InterviewRequestError
			? resource.error.problem
			: undefined;
	const offsets = resource.data?.offsets ?? problem?.offsets ?? [];
	return (
		<FieldGroup className="gap-3">
			<div className="flex items-baseline justify-between gap-2">
				<p className="font-semibold">Interview slot</p>
				<p className="text-xs text-muted-foreground">
					Time zone{" "}
					<span className="font-medium text-foreground">{timeZone}</span>
				</p>
			</div>
			<FieldGroup className="grid grid-cols-2 gap-3 sm:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)_minmax(0,1fr)]">
				<Field>
					<FieldLabel htmlFor={`${id}-date`}>Date</FieldLabel>
					<Input
						id={`${id}-date`}
						className="min-w-0"
						type="date"
						required
						value={value.date}
						onChange={(event) =>
							onChange({
								...value,
								date: event.target.value,
								offset: undefined,
							})
						}
					/>
				</Field>
				<Field>
					<FieldLabel htmlFor={`${id}-time`}>Start time</FieldLabel>
					<Input
						id={`${id}-time`}
						className="min-w-0"
						type="time"
						required
						value={value.time}
						onChange={(event) =>
							onChange({
								...value,
								time: event.target.value,
								offset: undefined,
							})
						}
					/>
				</Field>
				<Field className="min-w-0">
					<FieldLabel htmlFor={`${id}-duration`}>Duration (minutes)</FieldLabel>
					<Input
						id={`${id}-duration`}
						required
						type="number"
						min={5}
						max={480}
						value={value.duration}
						onChange={(event) =>
							onChange({ ...value, duration: event.target.value })
						}
					/>
				</Field>
			</FieldGroup>
			{offsets.length > 1 && (
				<Field>
					<FieldLabel htmlFor={`${id}-offset`}>UTC offset</FieldLabel>
					<Select
						value={value.offset ?? null}
						onValueChange={(offset) =>
							onChange({ ...value, offset: offset ?? undefined })
						}
						items={offsets.map((offset) => ({
							value: offset,
							label: `UTC${offset}`,
						}))}
					>
						<SelectTrigger id={`${id}-offset`}>
							<SelectValue placeholder="Choose an offset" />
						</SelectTrigger>
						<SelectContent>
							<SelectGroup>
								{offsets.map((offset) => (
									<SelectItem
										key={offset}
										value={offset}
									>{`UTC${offset}`}</SelectItem>
								))}
							</SelectGroup>
						</SelectContent>
					</Select>
				</Field>
			)}
			{resource.error !== undefined && (
				<>
					<InterviewAlert error={resource.error} />
					{!problem && (
						<Button
							type="button"
							variant="outline"
							className="self-start"
							onClick={resource.refresh}
						>
							Retry time preview
						</Button>
					)}
				</>
			)}
			{resource.loading && (
				<p role="status" className="text-muted-foreground">
					Calculating end time…
				</p>
			)}
			{resource.data && (
				<p
					role="status"
					className="rounded-md bg-muted px-3 py-2 text-muted-foreground"
				>
					{scheduleLabel(resource.data.start, resource.data.end, timeZone)}
				</p>
			)}
		</FieldGroup>
	);
}

export function MeetingFields({
	value,
	onChange,
	allowMode = true,
}: {
	value: InterviewMeeting;
	onChange: (value: InterviewMeeting) => void;
	allowMode?: boolean;
}) {
	const id = useId();
	const modes = [
		{ value: "virtual", label: "Virtual" },
		{ value: "in_person", label: "In person" },
	];
	return (
		<FieldGroup className="gap-3">
			{allowMode && <p className="font-semibold">Meeting</p>}
			{allowMode && (
				<Field>
					<FieldLabel htmlFor={`${id}-mode`}>Interview mode</FieldLabel>
					<Select
						value={value.mode}
						items={modes}
						onValueChange={(mode) =>
							onChange(
								mode === "in_person"
									? { mode, room: "" }
									: { mode: "virtual", teamsUrl: null },
							)
						}
					>
						<SelectTrigger id={`${id}-mode`} className="w-full">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							<SelectGroup>
								{modes.map((mode) => (
									<SelectItem key={mode.value} value={mode.value}>
										{mode.label}
									</SelectItem>
								))}
							</SelectGroup>
						</SelectContent>
					</Select>
				</Field>
			)}
			{value.mode === "virtual" ? (
				<Field>
					<FieldLabel htmlFor={`${id}-teams`}>Teams URL (optional)</FieldLabel>
					<Input
						id={`${id}-teams`}
						type="url"
						maxLength={2_048}
						placeholder="https://…"
						value={value.teamsUrl ?? ""}
						onChange={(event) =>
							onChange({
								mode: "virtual",
								teamsUrl: event.target.value || null,
							})
						}
					/>
					<FieldDescription>
						You can add the Teams URL after booking.
					</FieldDescription>
				</Field>
			) : (
				<Field>
					<FieldLabel htmlFor={`${id}-room`}>Room</FieldLabel>
					<Input
						id={`${id}-room`}
						required
						maxLength={160}
						value={value.room}
						onChange={(event) =>
							onChange({ mode: "in_person", room: event.target.value })
						}
					/>
				</Field>
			)}
		</FieldGroup>
	);
}
