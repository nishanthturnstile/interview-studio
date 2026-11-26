import { Link, Outlet } from "@tanstack/react-router";
import { ThemeButton } from "@/components/theme-button";
import "./auth.css";

export function AuthLayout() {
	return (
		<div className="min-h-svh bg-card lg:grid lg:grid-cols-[47%_minmax(0,1fr)]">
			<div className="auth-photograph hidden lg:block">
				<Link
					to="/"
					className="inline-block font-display text-[clamp(2.5rem,3.6vw,3.75rem)] leading-[1.08] tracking-tight focus-visible:outline-current"
				>
					Interview Studio
				</Link>
				<p className="mt-3 text-base">Plan, run, and review interviews.</p>
			</div>
			<div className="flex min-w-0 flex-col lg:min-h-svh">
				<header className="border-b border-border lg:border-b-0">
					<div className="mx-auto flex min-h-16 max-w-xl items-center justify-between gap-2 px-5 sm:px-8 lg:min-h-20 lg:justify-end">
						<Link
							to="/"
							className="border-s-2 border-primary ps-3 text-lg leading-tight font-bold tracking-tight sm:text-xl lg:hidden"
						>
							Interview Studio
						</Link>
						<ThemeButton />
					</div>
				</header>
				<main className="mx-auto flex w-full max-w-[29rem] flex-1 flex-col justify-center px-5 py-9 sm:px-8 sm:py-12">
					<Outlet />
				</main>
			</div>
		</div>
	);
}
