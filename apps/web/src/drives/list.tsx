import {
	canViewDrives,
	type DriveOverview,
	driveCreateSchema,
} from "@studio/contracts";
import { useQueryClient } from "@tanstack/react-query";
import {
	getRouteApi,
	Link,
	Navigate,
	useNavigate,
} from "@tanstack/react-router";
import { FolderOpen, Plus } from "lucide-react";
import {
	type FormEvent,
	useCallback,
	useEffect,
	useId,
	useRef,
	useState,
} from "react";
import { Alert, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "@/components/ui/dialog";
import {
	Empty,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from "@/components/ui/empty";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table";
import { invalidateHrInterviews } from "../interviews/hr-queries";
import {
	createdDriveSchema,
	type DriveRequest,
	driveListSchema,
	jsonRequest,
	requestMessage,
	useDriveRequest,
} from "./api";

function CreateDrive({ request }: { request: DriveRequest }) {
	const [open, setOpen] = useState(false);
	const [name, setName] = useState("");
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState("");
	const attempt = useRef<{ name: string; key: string }>(null);
	const inputId = useId();
	const navigate = useNavigate();
	const queryClient = useQueryClient();
	async function submit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		const input = driveCreateSchema.safeParse({ name });
		if (!input.success) {
			setError("Enter a drive name of up to 120 characters.");
			return;
		}
		if (attempt.current?.name !== input.data.name)
			attempt.current = { name: input.data.name, key: crypto.randomUUID() };
		setSaving(true);
		setError("");
		try {
			const { id } = await request(
				"",
				createdDriveSchema,
				jsonRequest("POST", input.data, {
					"Idempotency-Key": attempt.current.key,
				}),
			);
			void invalidateHrInterviews(queryClient);
			setOpen(false);
			await navigate({ to: "/staff/drives/$driveId", params: { driveId: id } });
		} catch (error) {
			setError(requestMessage(error));
		} finally {
			setSaving(false);
		}
	}

	return (
		<Dialog
			open={open}
			onOpenChange={(value) => {
				if (!saving) setOpen(value);
			}}
		>
			<DialogTrigger render={<Button />}>
				<Plus aria-hidden="true" />
				New drive
			</DialogTrigger>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>New drive</DialogTitle>
					<DialogDescription>
						Use one drive per hiring requirement.
					</DialogDescription>
				</DialogHeader>
				<form className="flex flex-col gap-4" onSubmit={submit}>
					<FieldGroup>
						<Field>
							<FieldLabel htmlFor={inputId}>Drive name</FieldLabel>
							<Input
								id={inputId}
								value={name}
								onChange={(event) => setName(event.target.value)}
								maxLength={120}
								required
								disabled={saving}
							/>
						</Field>
					</FieldGroup>
					{error && (
						<Alert variant="destructive">
							<AlertTitle>{error}</AlertTitle>
						</Alert>
					)}
					<DialogFooter>
						<Button type="submit" disabled={saving}>
							{saving ? "Creating…" : "Create drive"}
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}

function DriveList({ hr }: { hr: boolean }) {
	const request = useDriveRequest();
	const [drives, setDrives] = useState<DriveOverview[]>();
	const [next, setNext] = useState<string | null>(null);
	const [error, setError] = useState("");
	const [loading, setLoading] = useState(true);
	const load = useCallback(
		async (cursor?: string, signal?: AbortSignal) => {
			setLoading(true);
			setError("");
			try {
				const data = await request(
					cursor ? `?after=${cursor}` : "",
					driveListSchema,
					{ signal },
				);
				setDrives((current) =>
					cursor ? [...(current ?? []), ...data.items] : data.items,
				);
				setNext(data.next);
			} catch (error) {
				if (!signal?.aborted) setError(requestMessage(error));
			} finally {
				if (!signal?.aborted) setLoading(false);
			}
		},
		[request],
	);
	useEffect(() => {
		const controller = new AbortController();
		void load(undefined, controller.signal);
		return () => controller.abort();
	}, [load]);

	return (
		<section className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 py-8 sm:px-8 sm:py-10">
			<div className="flex flex-wrap items-center justify-between gap-4">
				<h1 className="text-3xl font-bold">Drives</h1>
				{hr && <CreateDrive request={request} />}
			</div>
			{error && (
				<Alert variant="destructive">
					<AlertTitle>{error}</AlertTitle>
					<Button
						variant="outline"
						onClick={() => void load(drives && next ? next : undefined)}
					>
						Try again
					</Button>
				</Alert>
			)}
			{loading && !drives && (
				<p role="status" className="text-muted-foreground">
					Loading drives…
				</p>
			)}
			{drives?.length === 0 && (
				<Empty className="min-h-56 border bg-card">
					<EmptyHeader>
						<EmptyMedia variant="icon">
							<FolderOpen aria-hidden="true" />
						</EmptyMedia>
						<EmptyTitle>No drives yet</EmptyTitle>
					</EmptyHeader>
				</Empty>
			)}
			{drives && drives.length > 0 && (
				<Card>
					<CardContent className="px-3 sm:px-5">
						<Table>
							<TableHeader>
								<TableRow>
									<TableHead>Drive</TableHead>
									<TableHead>Resumes</TableHead>
									<TableHead>Confirmed</TableHead>
									<TableHead className="hidden md:table-cell">
										Skills reviewed
									</TableHead>
								</TableRow>
							</TableHeader>
							<TableBody>
								{drives.map((drive) => (
									<TableRow key={drive.id}>
										<TableCell className="max-w-48 whitespace-normal [overflow-wrap:anywhere]">
											<Link
												className="font-semibold underline-offset-4 hover:underline"
												to="/staff/drives/$driveId"
												params={{ driveId: drive.id }}
											>
												{drive.name}
											</Link>
										</TableCell>
										<TableCell>{drive.counts.resumes}</TableCell>
										<TableCell>{drive.counts.confirmed}</TableCell>
										<TableCell className="hidden md:table-cell">
											<Badge variant="secondary">
												{drive.skills.filter((set) => set.reviewedAt).length} of
												2
											</Badge>
										</TableCell>
									</TableRow>
								))}
							</TableBody>
						</Table>
					</CardContent>
				</Card>
			)}
			{next && (
				<Button
					variant="outline"
					className="self-start"
					disabled={loading}
					onClick={() => void load(next)}
				>
					{loading ? "Loading…" : "Load more drives"}
				</Button>
			)}
		</section>
	);
}

export function StaffDrives() {
	const { id, role } = getRouteApi("/staff").useLoaderData();
	if (!canViewDrives(role)) return <Navigate to="/staff" replace />;
	return <DriveList key={`${id}:${role}`} hr={role === "hr"} />;
}
