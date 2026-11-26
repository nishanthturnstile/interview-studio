import { getRouteApi, Link } from "@tanstack/react-router";
import { FolderOpen } from "lucide-react";
import { type ReactNode, useId } from "react";
import { setDarkMode, useDarkMode } from "@/components/theme";
import { Alert, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import {
	Empty,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from "@/components/ui/empty";
import { Field, FieldLabel } from "@/components/ui/field";
import {
	Select,
	SelectContent,
	SelectGroup,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { canViewDrives, roleName } from "./staff-display";

const staffRoute = getRouteApi("/staff");

function StaffSection({
	title,
	children,
}: {
	title: string;
	children: ReactNode;
}) {
	return (
		<section className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 py-8 sm:px-8 sm:py-10">
			<h1 className="text-3xl leading-tight font-bold">{title}</h1>
			{children}
		</section>
	);
}

export function StaffDashboard() {
	const viewer = staffRoute.useLoaderData();
	return (
		<StaffSection title="Dashboard">
			<Card className="max-w-2xl">
				<CardHeader>
					<CardTitle className="[overflow-wrap:anywhere]">
						Welcome, {viewer.name}
					</CardTitle>
				</CardHeader>
				<CardContent className="flex flex-wrap items-center justify-between gap-4">
					<Badge variant="secondary">{roleName[viewer.role]}</Badge>
					{viewer.role === "director" && (
						<Link
							to="/staff/access"
							className={buttonVariants({ variant: "outline" })}
						>
							Manage staff access
						</Link>
					)}
				</CardContent>
			</Card>
		</StaffSection>
	);
}

export function StaffDrives() {
	const role = staffRoute.useLoaderData({ select: (viewer) => viewer.role });
	return (
		<StaffSection title="Drives">
			{canViewDrives(role) ? (
				<Empty className="min-h-56 max-w-2xl border bg-card">
					<EmptyHeader>
						<EmptyMedia variant="icon">
							<FolderOpen aria-hidden="true" />
						</EmptyMedia>
						<EmptyTitle>Interview drives</EmptyTitle>
						<EmptyDescription>
							{role === "hr"
								? "You’ll be able to create and manage interview drives here in a later update."
								: "Interview drives will appear here when the HR workspace is ready."}
						</EmptyDescription>
					</EmptyHeader>
				</Empty>
			) : (
				<Alert variant="destructive" className="max-w-2xl">
					<AlertTitle>Drives are available to HR and directors.</AlertTitle>
				</Alert>
			)}
		</StaffSection>
	);
}

export function StaffAccount() {
	const viewer = staffRoute.useLoaderData();
	return (
		<StaffSection title="Account">
			<Card className="max-w-2xl">
				<CardHeader>
					<CardTitle>Your profile</CardTitle>
				</CardHeader>
				<CardContent>
					<dl className="flex flex-col gap-4">
						<div>
							<dt className="text-sm text-muted-foreground">Name</dt>
							<dd className="font-medium [overflow-wrap:anywhere]">
								{viewer.name}
							</dd>
						</div>
						<div>
							<dt className="text-sm text-muted-foreground">Work email</dt>
							<dd className="font-medium [overflow-wrap:anywhere]">
								{viewer.email}
							</dd>
						</div>
						<div>
							<dt className="mb-1 text-sm text-muted-foreground">Staff role</dt>
							<dd>
								<Badge variant="secondary">{roleName[viewer.role]}</Badge>
							</dd>
						</div>
					</dl>
				</CardContent>
			</Card>
		</StaffSection>
	);
}

const themeOptions = [
	{ value: "light", label: "Light mode" },
	{ value: "dark", label: "Dark mode" },
];

function AppearanceSetting() {
	const dark = useDarkMode();
	const themeId = useId();
	return (
		<Field className="max-w-56">
			<FieldLabel htmlFor={themeId}>Theme</FieldLabel>
			<Select
				items={themeOptions}
				value={dark ? "dark" : "light"}
				onValueChange={(value) => setDarkMode(value === "dark")}
			>
				<SelectTrigger id={themeId} className="w-full">
					<SelectValue />
				</SelectTrigger>
				<SelectContent>
					<SelectGroup>
						{themeOptions.map(({ value, label }) => (
							<SelectItem key={value} value={value}>
								{label}
							</SelectItem>
						))}
					</SelectGroup>
				</SelectContent>
			</Select>
		</Field>
	);
}

export function StaffSettings() {
	return (
		<StaffSection title="Settings">
			<Card className="max-w-2xl">
				<CardHeader>
					<CardTitle>Appearance</CardTitle>
					<CardDescription>
						Choose how Interview Studio looks on this device.
					</CardDescription>
				</CardHeader>
				<CardContent>
					<AppearanceSetting />
				</CardContent>
			</Card>
		</StaffSection>
	);
}
