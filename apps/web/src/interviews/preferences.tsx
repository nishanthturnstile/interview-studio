import {
	type InterviewPreferences,
	interviewPreferencesSchema,
} from "@studio/contracts";
import { type FormEvent, useId, useState } from "react";
import { Alert, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import {
	Field,
	FieldDescription,
	FieldGroup,
	FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
	InterviewRequestError,
	interviewRequest,
	useInterviewResource,
} from "./api";
import { InterviewAlert, InterviewLoading } from "./display";

const zones = [
	...new Set(["Asia/Kolkata", "UTC", ...Intl.supportedValuesOf("timeZone")]),
];

function PreferencesForm({ initial }: { initial: InterviewPreferences }) {
	const id = useId();
	const [current, setCurrent] = useState(initial);
	const [zone, setZone] = useState(initial.timeZone);
	const [duration, setDuration] = useState(String(initial.duration));
	const [busy, setBusy] = useState(false);
	const [saved, setSaved] = useState(false);
	const [error, setError] = useState<unknown>();
	async function save(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		if (busy) return;
		setSaved(false);
		setError(undefined);
		setBusy(true);
		try {
			const next = await interviewRequest(
				"/staff/settings/interviews",
				interviewPreferencesSchema,
				{
					method: "PATCH",
					data: {
						timeZone: zone,
						duration: Number(duration),
						revision: current.revision,
					},
				},
			);
			setCurrent(next);
			setZone(next.timeZone);
			setDuration(String(next.duration));
			setSaved(true);
		} catch (error) {
			setError(error);
			if (error instanceof InterviewRequestError && error.problem?.preferences)
				setCurrent(error.problem.preferences);
		} finally {
			setBusy(false);
		}
	}
	return (
		<form onSubmit={save} className="flex flex-col gap-4">
			<FieldGroup>
				<Field>
					<FieldLabel htmlFor={`${id}-zone`}>Default time zone</FieldLabel>
					<Input
						id={`${id}-zone`}
						list={`${id}-zones`}
						value={zone}
						required
						maxLength={100}
						onChange={(event) => {
							setZone(event.target.value);
							setSaved(false);
						}}
					/>
					<datalist id={`${id}-zones`}>
						{zones.map((value) => (
							<option key={value} value={value} />
						))}
					</datalist>
					<FieldDescription>
						Use an IANA time zone, such as Asia/Kolkata or America/New_York.
					</FieldDescription>
				</Field>
				<Field className="max-w-54">
					<FieldLabel htmlFor={`${id}-duration`}>
						Default duration (minutes)
					</FieldLabel>
					<Input
						id={`${id}-duration`}
						type="number"
						required
						min={5}
						max={480}
						value={duration}
						onChange={(event) => {
							setDuration(event.target.value);
							setSaved(false);
						}}
					/>
				</Field>
			</FieldGroup>
			{error !== undefined && <InterviewAlert error={error} />}
			{error instanceof InterviewRequestError && error.problem?.preferences && (
				<p className="text-sm">
					The saved default is {current.timeZone}, {current.duration} minutes.
					Review your entries before saving.
				</p>
			)}
			{saved && (
				<Alert variant="success" role="status">
					<AlertTitle>Scheduling preferences saved.</AlertTitle>
				</Alert>
			)}
			<Button
				type="submit"
				className="self-start"
				disabled={
					busy ||
					(zone === current.timeZone && duration === String(current.duration))
				}
			>
				{busy ? "Saving…" : "Save preferences"}
			</Button>
		</form>
	);
}

export function SchedulingPreferences() {
	const { data, error, refresh } = useInterviewResource(
		"/staff/settings/interviews",
		interviewPreferencesSchema,
	);
	return (
		<Card className="max-w-2xl">
			<CardHeader>
				<CardTitle>Interview scheduling</CardTitle>
				<CardDescription>
					These defaults apply to new bookings you create.
				</CardDescription>
			</CardHeader>
			<CardContent>
				{data ? (
					<PreferencesForm initial={data} />
				) : error !== undefined ? (
					<div className="flex flex-col gap-2">
						<InterviewAlert error={error} />
						<Button variant="outline" className="self-start" onClick={refresh}>
							Try again
						</Button>
					</div>
				) : (
					<InterviewLoading />
				)}
			</CardContent>
		</Card>
	);
}
