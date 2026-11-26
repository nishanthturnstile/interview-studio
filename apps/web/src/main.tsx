import { type Health, healthSchema } from "@studio/contracts";
import {
	createRootRoute,
	createRoute,
	createRouter,
	Link,
	lazyRouteComponent,
	RouterProvider,
} from "@tanstack/react-router";
import { CircleAlert, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { readDarkMode } from "@/components/theme";
import { ThemeButton } from "@/components/theme-button";
import { Alert, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { TooltipProvider } from "@/components/ui/tooltip";
import { loadStaff, loadStaffAccess } from "./staff/staff-api.ts";
import "./globals.css";

const services = [
	["database", "Database"],
	["worker", "Background worker"],
	["storage", "Private file storage"],
] as const satisfies ReadonlyArray<readonly [keyof Health["services"], string]>;

function ServiceStatus({
	online,
	checking,
}: {
	online?: boolean;
	checking: boolean;
}) {
	if (checking) return <Badge variant="info">Checking</Badge>;
	if (online === undefined) return <Badge variant="muted">Unknown</Badge>;
	if (online) return <Badge variant="success">Ready</Badge>;
	return <Badge variant="error">Unavailable</Badge>;
}

function StudioStatus() {
	const [health, setHealth] = useState<Health>();
	const [checking, setChecking] = useState(true);

	const refresh = useCallback(async () => {
		setChecking(true);
		try {
			const response = await fetch("/api/health", {
				signal: AbortSignal.timeout(5_000),
			});
			setHealth(healthSchema.parse(await response.json()));
		} catch {
			setHealth(undefined);
		} finally {
			setChecking(false);
		}
	}, []);

	useEffect(() => {
		void refresh();
	}, [refresh]);

	const failed = !checking && health?.status !== "ready";

	return (
		<main className="mx-auto max-w-5xl px-4 py-8 sm:px-8 sm:py-12">
			<section aria-labelledby="status-title" className="max-w-2xl">
				<Card className="overflow-visible">
					<CardHeader>
						<div className="flex flex-wrap items-start justify-between gap-4">
							<div>
								<h2 id="status-title" className="text-xl font-semibold">
									Local service status
								</h2>
								<p role="status" className="mt-1 text-sm text-muted-foreground">
									{checking
										? "Checking connection…"
										: health?.status === "ready"
											? "All services ready"
											: null}
								</p>
							</div>
							<Button type="button" onClick={refresh} disabled={checking}>
								<RefreshCw aria-hidden="true" />
								Check again
							</Button>
						</div>
					</CardHeader>
					<CardContent>
						{failed && (
							<Alert variant="destructive" className="mb-4">
								<CircleAlert aria-hidden="true" />
								<AlertTitle>
									{health
										? "Some services are unavailable"
										: "Cannot reach the server"}
								</AlertTitle>
							</Alert>
						)}
						<dl
							aria-busy={checking}
							className="divide-y divide-border border-t border-border"
						>
							{services.map(([service, label]) => (
								<div
									key={service}
									className="flex min-h-12 flex-wrap items-center justify-between gap-2 py-2"
								>
									<dt className="font-semibold">{label}</dt>
									<dd>
										<ServiceStatus
											online={health?.services[service]}
											checking={checking}
										/>
									</dd>
								</div>
							))}
						</dl>
					</CardContent>
				</Card>
			</section>
			<Link to="/sign-in" className={buttonVariants({ className: "mt-6" })}>
				Staff sign in
			</Link>
		</main>
	);
}

function StudioHome() {
	return (
		<>
			<header className="border-b border-border bg-card">
				<div className="mx-auto flex min-h-16 max-w-5xl flex-wrap items-center justify-between gap-x-4 px-4 py-2 sm:px-8">
					<h1 className="text-[1.75rem]/[1.2] font-bold">Interview Studio</h1>
					<ThemeButton />
				</div>
			</header>
			<StudioStatus />
		</>
	);
}

const rootRoute = createRootRoute();
const authRoute = createRoute({
	getParentRoute: () => rootRoute,
	id: "_auth",
	component: lazyRouteComponent(
		() => import("./staff/auth-layout.tsx"),
		"AuthLayout",
	),
});
const index = createRoute({
	getParentRoute: () => rootRoute,
	path: "/",
	component: StudioHome,
});
const signIn = createRoute({
	getParentRoute: () => authRoute,
	path: "/sign-in",
	component: lazyRouteComponent(
		() => import("./staff/auth-pages.tsx"),
		"SignIn",
	),
});
const signUp = createRoute({
	getParentRoute: () => authRoute,
	path: "/sign-up",
	component: lazyRouteComponent(
		() => import("./staff/auth-pages.tsx"),
		"SignUp",
	),
});
const verifyEmail = createRoute({
	getParentRoute: () => authRoute,
	path: "/verify-email",
	component: lazyRouteComponent(
		() => import("./staff/auth-pages.tsx"),
		"VerifyEmail",
	),
});
const forgotPassword = createRoute({
	getParentRoute: () => authRoute,
	path: "/forgot-password",
	component: lazyRouteComponent(
		() => import("./staff/auth-pages.tsx"),
		"ForgotPassword",
	),
});
const resetPassword = createRoute({
	getParentRoute: () => authRoute,
	path: "/reset-password",
	component: lazyRouteComponent(
		() => import("./staff/auth-pages.tsx"),
		"ResetPassword",
	),
});

const staffRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "/staff",
	loader: loadStaff,
	component: lazyRouteComponent(
		() => import("./staff/staff-layout.tsx"),
		"StaffLayout",
	),
});
const dashboardRoute = createRoute({
	getParentRoute: () => staffRoute,
	path: "/",
	component: lazyRouteComponent(
		() => import("./staff/staff-pages.tsx"),
		"StaffDashboard",
	),
});
const drivesRoute = createRoute({
	getParentRoute: () => staffRoute,
	path: "drives",
	component: lazyRouteComponent(
		() => import("./drives/list.tsx"),
		"StaffDrives",
	),
});
const driveDetailRoute = createRoute({
	getParentRoute: () => staffRoute,
	path: "drives/$driveId",
	component: lazyRouteComponent(
		() => import("./drives/detail.tsx"),
		"StaffDriveDetail",
	),
});
const accountRoute = createRoute({
	getParentRoute: () => staffRoute,
	path: "account",
	component: lazyRouteComponent(
		() => import("./staff/staff-pages.tsx"),
		"StaffAccount",
	),
});
const settingsRoute = createRoute({
	getParentRoute: () => staffRoute,
	path: "settings",
	component: lazyRouteComponent(
		() => import("./staff/staff-pages.tsx"),
		"StaffSettings",
	),
});
const accessRoute = createRoute({
	getParentRoute: () => staffRoute,
	path: "access",
	loader: loadStaffAccess,
	component: lazyRouteComponent(
		() => import("./staff/workspace.tsx"),
		"StaffAccess",
	),
});

const router = createRouter({
	routeTree: rootRoute.addChildren([
		index,
		staffRoute.addChildren([
			dashboardRoute,
			drivesRoute,
			driveDetailRoute,
			accountRoute,
			settingsRoute,
			accessRoute,
		]),
		authRoute.addChildren([
			signIn,
			signUp,
			verifyEmail,
			forgotPassword,
			resetPassword,
		]),
	]),
	defaultPendingComponent: () => (
		<p role="status" className="mx-auto max-w-5xl p-8">
			Loading staff workspace…
		</p>
	),
	defaultErrorComponent: () => (
		<main className="mx-auto max-w-5xl p-8">
			<Alert variant="destructive">
				<AlertTitle>Couldn’t load this page.</AlertTitle>
			</Alert>
			<Button
				variant="outline"
				className="mt-4"
				onClick={() => window.location.reload()}
			>
				Try again
			</Button>
		</main>
	),
});

declare module "@tanstack/react-router" {
	interface Register {
		router: typeof router;
	}
}

document.documentElement.classList.toggle("dark", readDarkMode());
const root = document.getElementById("root");
if (root) {
	createRoot(root).render(
		<TooltipProvider>
			<RouterProvider router={router} />
		</TooltipProvider>,
	);
}
