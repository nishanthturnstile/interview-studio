import {
	type SkillSet,
	skillSaveSchema,
	skillSetSchema,
} from "@studio/contracts";
import { ArrowDown, ArrowUp, Check, Plus, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Alert, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldGroup } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
	type DriveRequest,
	DriveRequestError,
	jsonRequest,
	requestMessage,
} from "./api";

type SkillRow = { key: string; id?: string; name: string };

export function Skills({
	driveId,
	set,
	hr,
	request,
	onSaved,
	onDirty,
}: {
	driveId: string;
	set: SkillSet;
	hr: boolean;
	request: DriveRequest;
	onSaved: (set: SkillSet) => void;
	onDirty: (key: string, dirty: boolean) => void;
}) {
	const [draft, setDraft] = useState<{ revision: number; rows: SkillRow[] }>();
	const [saving, setSaving] = useState(false);
	const [notice, setNotice] = useState("");
	const [error, setError] = useState("");
	const [current, setCurrent] = useState<SkillSet>();
	const addFocus = useRef<string>(undefined);
	const rows =
		draft?.rows ?? set.skills.map(({ id, name }) => ({ key: id, id, name }));
	const title = set.round.toUpperCase();
	const dirty = Boolean(draft);
	useEffect(() => {
		const key = `skills-${set.round}`;
		onDirty(key, dirty);
		return () => onDirty(key, false);
	}, [dirty, onDirty, set.round]);

	function edit(rows: SkillRow[]) {
		setDraft({ revision: draft?.revision ?? set.revision, rows });
		setNotice("");
	}

	function reorder(index: number, offset: -1 | 1) {
		const moved = [...rows];
		[moved[index], moved[index + offset]] = [
			moved[index + offset],
			moved[index],
		];
		edit(moved);
	}

	async function save(review: boolean) {
		const payload = review
			? { revision: set.revision }
			: {
					revision: draft?.revision ?? set.revision,
					skills: rows.map(({ id, name }) => ({ id, name })),
				};
		if (!review && !skillSaveSchema.safeParse(payload).success) {
			setError("Enter a unique name for each skill in this round.");
			return;
		}
		setSaving(true);
		setError("");
		setNotice("");
		setCurrent(undefined);
		try {
			const updated = await request(
				`/${driveId}/skills/${set.round}${review ? "/review" : ""}`,
				skillSetSchema,
				jsonRequest(review ? "POST" : "PUT", payload),
			);
			onSaved(updated);
			setDraft(undefined);
			setNotice(
				review ? `${title} marked reviewed.` : `${title} skills saved.`,
			);
		} catch (error) {
			setError(requestMessage(error));
			if (
				error instanceof DriveRequestError &&
				error.problem.error === "revision_conflict"
			) {
				const latest = skillSetSchema.safeParse(error.problem.current);
				if (latest.success) setCurrent(latest.data);
			}
		} finally {
			setSaving(false);
		}
	}

	return (
		<Card className="min-w-0 gap-4">
			<CardHeader className="flex flex-wrap items-center justify-between gap-2">
				<CardTitle>
					<h3>{title} skills</h3>
				</CardTitle>
				{(dirty || rows.length > 0) && (
					<Badge
						variant={
							dirty ? "warning" : set.reviewedAt ? "success" : "secondary"
						}
					>
						{dirty
							? "Unsaved changes"
							: set.reviewedAt
								? "Reviewed"
								: "Awaiting review"}
					</Badge>
				)}
			</CardHeader>
			<CardContent className="flex min-w-0 flex-col gap-4">
				{!rows.length && (
					<p className="rounded-md border border-dashed bg-muted/35 px-4 py-5 text-sm text-muted-foreground">
						{hr
							? "Add the skills this round will assess."
							: "No skills have been added."}
					</p>
				)}
				{hr ? (
					<FieldGroup className="min-w-0 gap-2">
						{rows.length > 0 && (
							<ol className="flex min-w-0 flex-col gap-1.5">
								{rows.map((row, index) => (
									<li
										key={row.key}
										className="rounded-md bg-muted/45 px-2 py-1.5"
									>
										<Field
											orientation="horizontal"
											className="grid min-w-0 grid-cols-[1.4rem_minmax(0,1fr)] gap-x-2 gap-y-0 @min-[335px]/field-group:grid-cols-[1.4rem_minmax(0,1fr)_auto]"
										>
											<span
												aria-hidden="true"
												className="text-center text-xs tabular-nums text-muted-foreground"
											>
												{index + 1}
											</span>
											<Input
												ref={(input) => {
													if (input && addFocus.current === row.key) {
														input.focus();
														addFocus.current = undefined;
													}
												}}
												className="min-w-0"
												placeholder="Skill name"
												aria-label={`${title} skill ${index + 1}`}
												value={row.name}
												maxLength={120}
												disabled={saving}
												onChange={(event) =>
													edit(
														rows.map((entry) =>
															entry.key === row.key
																? { ...entry, name: event.target.value }
																: entry,
														),
													)
												}
											/>
											<div className="col-start-2 flex items-center justify-self-end @min-[335px]/field-group:col-start-3 @min-[335px]/field-group:row-start-1">
												<Button
													type="button"
													size="icon-sm"
													variant="ghost"
													aria-label={`Move ${title} skill ${index + 1} up`}
													disabled={saving || index === 0}
													onClick={() => reorder(index, -1)}
												>
													<ArrowUp />
												</Button>
												<Button
													type="button"
													size="icon-sm"
													variant="ghost"
													aria-label={`Move ${title} skill ${index + 1} down`}
													disabled={saving || index === rows.length - 1}
													onClick={() => reorder(index, 1)}
												>
													<ArrowDown />
												</Button>
												<Button
													type="button"
													size="icon-sm"
													variant="ghost"
													aria-label={`Remove ${title} skill ${index + 1}`}
													disabled={saving}
													onClick={() =>
														edit(rows.filter((entry) => entry.key !== row.key))
													}
												>
													<Trash2 />
												</Button>
											</div>
										</Field>
									</li>
								))}
							</ol>
						)}
					</FieldGroup>
				) : (
					rows.length > 0 && (
						<ol className="list-decimal pl-5 text-sm">
							{rows.map((row) => (
								<li className="py-1 [overflow-wrap:anywhere]" key={row.key}>
									{row.name}
								</li>
							))}
						</ol>
					)
				)}
				{hr && (
					<div className="flex flex-wrap items-center gap-2">
						<Button
							size="sm"
							variant="outline"
							disabled={saving || rows.length >= 50}
							onClick={() => {
								const key = crypto.randomUUID();
								edit([...rows, { key, name: "" }]);
								addFocus.current = key;
							}}
						>
							<Plus />
							Add {title} skill
						</Button>
						{draft && (
							<Button
								size="sm"
								disabled={saving}
								onClick={() => void save(false)}
							>
								Save {title} skills
							</Button>
						)}
						{!draft && rows.length > 0 && !set.reviewedAt && (
							<Button
								size="sm"
								variant="outline"
								disabled={saving}
								onClick={() => void save(true)}
							>
								<Check aria-hidden="true" />
								Mark {title} reviewed
							</Button>
						)}
					</div>
				)}
				{error && (
					<Alert variant="destructive">
						<AlertTitle>{error}</AlertTitle>
					</Alert>
				)}
				{current && (
					<Button
						className="self-start"
						size="sm"
						variant="outline"
						onClick={() => {
							const latestIds = new Set(current.skills.map(({ id }) => id));
							if (draft)
								setDraft({
									revision: current.revision,
									rows: draft.rows.map((row) =>
										row.id && !latestIds.has(row.id)
											? { ...row, id: undefined }
											: row,
									),
								});
							onSaved(current);
							setCurrent(undefined);
							setError("");
						}}
					>
						Use latest {title} revision
					</Button>
				)}
				{notice && (
					<p role="status" className="text-sm">
						{notice}
					</p>
				)}
			</CardContent>
		</Card>
	);
}
