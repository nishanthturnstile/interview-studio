import type { StaffIdentity } from "@studio/contracts";
import { Link } from "@tanstack/react-router";
import {
	ChevronsUpDown,
	LogOut,
	Moon,
	Settings,
	Sun,
	UserRound,
} from "lucide-react";
import { useState } from "react";
import { setDarkMode, useDarkMode } from "@/components/theme";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuGroup,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
	SidebarMenu,
	SidebarMenuButton,
	SidebarMenuItem,
	useSidebar,
} from "@/components/ui/sidebar";
import { authClient } from "./auth-client";

function AppearanceMenu() {
	const dark = useDarkMode();
	return (
		<DropdownMenuGroup>
			<DropdownMenuLabel>Appearance</DropdownMenuLabel>
			<DropdownMenuRadioGroup
				value={dark ? "dark" : "light"}
				onValueChange={(value) => setDarkMode(value === "dark")}
			>
				<DropdownMenuRadioItem value="light" closeOnClick className="min-h-9">
					<Sun aria-hidden="true" />
					Light mode
				</DropdownMenuRadioItem>
				<DropdownMenuRadioItem value="dark" closeOnClick className="min-h-9">
					<Moon aria-hidden="true" />
					Dark mode
				</DropdownMenuRadioItem>
			</DropdownMenuRadioGroup>
		</DropdownMenuGroup>
	);
}

export function StaffAccountMenu({ viewer }: { viewer: StaffIdentity }) {
	const { setOpenMobile } = useSidebar();
	const [signingOut, setSigningOut] = useState(false);
	const [error, setError] = useState("");
	const initials = viewer.name
		.trim()
		.split(/\s+/)
		.slice(0, 2)
		.map((part) => Array.from(part)[0])
		.join("")
		.toUpperCase();

	async function signOut() {
		setSigningOut(true);
		setError("");
		try {
			const result = await authClient.signOut();
			if (!result.error) {
				window.location.replace("/sign-in");
				return;
			}
		} catch {
			// Keep the current session visible when the request fails.
		}
		setError("Couldn’t sign out. Try again.");
		setSigningOut(false);
	}

	return (
		<SidebarMenu>
			<SidebarMenuItem>
				<DropdownMenu
					onOpenChange={(open) => {
						if (!open) setError("");
					}}
				>
					<DropdownMenuTrigger
						aria-label={`Account menu for ${viewer.name}`}
						render={
							<SidebarMenuButton
								size="lg"
								className="group-data-[collapsible=icon]:justify-center"
							/>
						}
					>
						<Avatar aria-hidden="true">
							<AvatarFallback>{initials}</AvatarFallback>
						</Avatar>
						<span className="flex min-w-0 flex-1 flex-col group-data-[collapsible=icon]:hidden">
							<span className="truncate font-semibold">{viewer.name}</span>
							<span className="truncate text-xs text-muted-foreground">
								{viewer.email}
							</span>
						</span>
						<ChevronsUpDown
							className="group-data-[collapsible=icon]:hidden"
							aria-hidden="true"
						/>
					</DropdownMenuTrigger>
					<DropdownMenuContent
						side="top"
						align="start"
						sideOffset={8}
						className="min-w-56 max-w-[calc(100vw-2rem)]"
					>
						<DropdownMenuGroup>
							<DropdownMenuLabel className="truncate">
								{viewer.email}
							</DropdownMenuLabel>
							<DropdownMenuItem
								className="min-h-9"
								render={
									<Link
										to="/staff/account"
										onClick={() => setOpenMobile(false)}
									/>
								}
							>
								<UserRound aria-hidden="true" />
								Account
							</DropdownMenuItem>
							<DropdownMenuItem
								className="min-h-9"
								render={
									<Link
										to="/staff/settings"
										onClick={() => setOpenMobile(false)}
									/>
								}
							>
								<Settings aria-hidden="true" />
								Settings
							</DropdownMenuItem>
						</DropdownMenuGroup>
						<DropdownMenuSeparator />
						<AppearanceMenu />
						<DropdownMenuSeparator />
						<DropdownMenuGroup>
							<DropdownMenuItem
								variant="destructive"
								className="min-h-9"
								disabled={signingOut}
								closeOnClick={false}
								onClick={signOut}
							>
								<LogOut aria-hidden="true" />
								{signingOut ? "Signing out…" : "Sign out"}
							</DropdownMenuItem>
						</DropdownMenuGroup>
						{error && (
							<p role="alert" className="px-2 py-1 text-sm text-destructive">
								{error}
							</p>
						)}
					</DropdownMenuContent>
				</DropdownMenu>
			</SidebarMenuItem>
		</SidebarMenu>
	);
}
