import {
	availableStaffGrants,
	type GrantStaffRole,
	type StaffIdentity,
} from "@studio/contracts";
import { getRouteApi, useRouter } from "@tanstack/react-router";
import { type FormEvent, useId, useState } from "react";
import { Alert, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import {
	Select,
	SelectContent,
	SelectGroup,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { roleName } from "./staff-display";

function RoleGrant({
	person,
	onGranted,
}: {
	person: StaffIdentity;
	onGranted: (role: GrantStaffRole) => void;
}) {
	const [open, setOpen] = useState(false);
	const [role, setRole] = useState<GrantStaffRole | null>(null);
	const [pending, setPending] = useState(false);
	const [error, setError] = useState("");
	const roleId = useId();
	const choices = availableStaffGrants(person.role).map((value) => ({
		value,
		label: roleName[value],
	}));
	if (choices.length === 0) return null;

	async function submit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		if (!role || pending) return;
		setPending(true);
		setError("");
		try {
			const response = await fetch(
				`/api/staff/access/${encodeURIComponent(person.id)}`,
				{
					method: "PATCH",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ role }),
				},
			);
			if (response.status === 401) {
				window.location.replace("/sign-in");
				return;
			}
			if (response.status === 409) {
				setError(
					"This person’s role has changed. Refresh the page to see their current role.",
				);
				return;
			}
			if (!response.ok) {
				setError("Couldn’t grant access. Check permissions and try again.");
				return;
			}
			setOpen(false);
			onGranted(role);
		} catch {
			setError("Couldn’t grant access. Check your connection and try again.");
		} finally {
			setPending(false);
		}
	}

	return (
		<Dialog
			open={open}
			onOpenChange={(next) => {
				if (pending) return;
				setOpen(next);
				setRole(null);
				setError("");
			}}
		>
			<DialogTrigger
				render={
					<Button
						variant="outline"
						aria-label={`Change role for ${person.name}`}
					/>
				}
			>
				Change role
			</DialogTrigger>
			<DialogContent showCloseButton={false}>
				<DialogHeader>
					<DialogTitle>Grant staff access</DialogTitle>
					<DialogDescription className="[overflow-wrap:anywhere]">
						Choose a new role for {person.name} ({person.email}).
					</DialogDescription>
				</DialogHeader>
				<form className="flex flex-col gap-4" onSubmit={submit}>
					<FieldGroup>
						<Field>
							<FieldLabel htmlFor={roleId}>New role</FieldLabel>
							<Select<GrantStaffRole>
								items={choices}
								value={role}
								onValueChange={setRole}
								disabled={pending}
							>
								<SelectTrigger id={roleId} className="w-full">
									<SelectValue placeholder="Select a role" />
								</SelectTrigger>
								<SelectContent>
									<SelectGroup>
										{choices.map(({ value, label }) => (
											<SelectItem key={value} value={value}>
												{label}
											</SelectItem>
										))}
									</SelectGroup>
								</SelectContent>
							</Select>
						</Field>
					</FieldGroup>
					{error && (
						<Alert variant="destructive">
							<AlertTitle>{error}</AlertTitle>
						</Alert>
					)}
					<DialogFooter>
						<DialogClose
							render={
								<Button type="button" variant="outline" disabled={pending} />
							}
						>
							Cancel
						</DialogClose>
						<Button type="submit" disabled={!role || pending}>
							{pending ? "Granting access…" : "Grant access"}
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}

export function StaffAccess() {
	const staff = getRouteApi("/staff/access").useLoaderData();
	const router = useRouter();
	const [notice, setNotice] = useState("");

	return (
		<section className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-8 sm:py-10">
			<h1 className="text-3xl leading-tight font-bold">Staff access</h1>
			{staff ? (
				<>
					<p className="mt-2 mb-6 text-muted-foreground">
						Manage roles for verified staff accounts.
					</p>
					<p
						role="status"
						className={notice ? "mb-4 text-sm text-foreground" : "sr-only"}
					>
						{notice}
					</p>
					<Card className="overflow-visible">
						<CardHeader>
							<CardTitle>Verified staff</CardTitle>
						</CardHeader>
						<CardContent>
							<ul className="divide-y divide-border border-t border-border">
								{staff.map((person) => (
									<li
										key={person.id}
										className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3 py-3"
									>
										<div className="min-w-0 flex-1 basis-48">
											<p className="font-semibold [overflow-wrap:anywhere]">
												{person.name}
											</p>
											<p className="text-muted-foreground [overflow-wrap:anywhere]">
												{person.email}
											</p>
										</div>
										<div className="flex flex-wrap items-center gap-3">
											<Badge variant="secondary">{roleName[person.role]}</Badge>
											<RoleGrant
												person={person}
												onGranted={(role) => {
													void router.invalidate();
													setNotice(
														`${person.name} now has ${roleName[role]} access.`,
													);
												}}
											/>
										</div>
									</li>
								))}
							</ul>
						</CardContent>
					</Card>
				</>
			) : (
				<Alert variant="destructive" className="mt-6">
					<AlertTitle>Only directors can manage staff access.</AlertTitle>
				</Alert>
			)}
		</section>
	);
}
