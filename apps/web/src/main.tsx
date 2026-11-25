import { type Health, healthSchema } from "@studio/contracts";
import { CircleAlert, Moon, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { Alert, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { TooltipProvider } from "@/components/ui/tooltip";
import "./globals.css";

const services = [
	["database", "Database"],
	["worker", "Background worker"],
	["storage", "Private file storage"],
] as const satisfies ReadonlyArray<readonly [keyof Health["services"], string]>;

const themeKey = "interview-studio-theme";

function readDarkMode() {
	try {
		return localStorage.getItem(themeKey) === "dark";
	} catch {
		return false;
	}
}

function ThemeButton() {
	const [dark, setDark] = useState(readDarkMode);

	function applyTheme() {
		const next = !dark;
		document.documentElement.classList.toggle("dark", next);
		setDark(next);
		try {
			localStorage.setItem(themeKey, next ? "dark" : "light");
		} catch {
			// The theme still applies when storage is unavailable.
		}
	}

	return (
		<Button
			variant="ghost"
			type="button"
			aria-label="Dark mode"
			aria-pressed={dark}
			onClick={applyTheme}
		>
			<Moon aria-hidden="true" />
			<span className="hidden sm:inline">Dark mode</span>
		</Button>
	);
}

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
		<>
			<header className="border-b border-border bg-card">
				<div className="mx-auto flex min-h-16 max-w-5xl flex-wrap items-center justify-between gap-x-4 px-4 py-2 sm:px-8">
					<h1 className="text-[1.75rem]/[1.2] font-bold">Interview Studio</h1>
					<ThemeButton />
				</div>
			</header>
			<main className="mx-auto max-w-5xl px-4 py-8 sm:px-8 sm:py-12">
				<section aria-labelledby="status-title" className="max-w-2xl">
					<Card className="overflow-visible">
						<CardHeader>
							<div className="flex flex-wrap items-start justify-between gap-4">
								<div>
									<h2 id="status-title" className="text-xl font-semibold">
										Local service status
									</h2>
									<p
										role="status"
										className="mt-1 text-sm text-muted-foreground"
									>
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
			</main>
		</>
	);
}

document.documentElement.classList.toggle("dark", readDarkMode());
const root = document.getElementById("root");
if (root) {
	createRoot(root).render(
		<TooltipProvider>
			<StudioStatus />
		</TooltipProvider>,
	);
}
