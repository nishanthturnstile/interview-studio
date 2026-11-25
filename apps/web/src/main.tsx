import { type Health, healthSchema } from "@studio/contracts";
import { useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

const serviceNames = {
	database: "Database",
	worker: "Background worker",
	storage: "Private file storage",
} satisfies Record<keyof Health["services"], string>;

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

	const summary = checking
		? "Checking connection…"
		: health?.status === "ready"
			? "All services ready"
			: health
				? "Some services are unavailable"
				: "Cannot reach the server";

	return (
		<main>
			<h1>Interview Studio</h1>
			<section aria-label="Local service status">
				<div className="status-heading">
					<p
						role="status"
						className={health?.status === "ready" ? "ready" : undefined}
					>
						{summary}
					</p>
					<button type="button" onClick={refresh} disabled={checking}>
						Check again
					</button>
				</div>
				<dl>
					{Object.entries(serviceNames).map(([key, label]) => {
						const online = health?.services[key as keyof Health["services"]];
						return (
							<div key={key}>
								<dt>{label}</dt>
								<dd className={online ? "ready" : undefined}>
									{checking
										? "Checking"
										: online === undefined
											? "Unknown"
											: online
												? "Ready"
												: "Unavailable"}
								</dd>
							</div>
						);
					})}
				</dl>
			</section>
		</main>
	);
}

const root = document.getElementById("root");
if (root) createRoot(root).render(<StudioStatus />);
