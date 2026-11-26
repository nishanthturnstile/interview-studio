import { canViewDrives, type StaffRole } from "@studio/contracts";
import {
	getRouteApi,
	Link,
	Outlet,
	useRouterState,
} from "@tanstack/react-router";
import { FolderOpen, LayoutDashboard, PanelsTopLeft, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
	Sidebar,
	SidebarContent,
	SidebarFooter,
	SidebarGroup,
	SidebarHeader,
	SidebarInset,
	SidebarMenu,
	SidebarMenuButton,
	SidebarMenuItem,
	SidebarProvider,
	SidebarSeparator,
	SidebarTrigger,
	useSidebar,
} from "@/components/ui/sidebar";
import { StaffAccountMenu } from "./staff-account-menu";

const staffRoute = getRouteApi("/staff");

const navigation = [
	{ label: "Dashboard", to: "/staff", icon: LayoutDashboard },
	{ label: "Drives", to: "/staff/drives", icon: FolderOpen },
] as const;

function WorkspaceNavigation({ role }: { role: StaffRole }) {
	const { setOpenMobile } = useSidebar();
	const pathname = useRouterState({
		select: (state) => state.location.pathname,
	});
	const items = canViewDrives(role) ? navigation : navigation.slice(0, 1);

	return (
		<nav aria-label="Staff navigation">
			<SidebarGroup>
				<SidebarMenu className="gap-1">
					{items.map(({ label, to, icon: Icon }) => (
						<SidebarMenuItem key={to}>
							<SidebarMenuButton
								size="lg"
								tooltip={label}
								isActive={
									pathname === to ||
									(to === "/staff/drives" && pathname.startsWith(`${to}/`))
								}
								className="h-10 group-data-[collapsible=icon]:justify-center"
								render={
									<Link
										to={to}
										activeOptions={{ exact: to === "/staff" }}
										aria-label={label}
										onClick={() => setOpenMobile(false)}
									/>
								}
							>
								<Icon aria-hidden="true" />
								<span className="group-data-[collapsible=icon]:hidden">
									{label}
								</span>
							</SidebarMenuButton>
						</SidebarMenuItem>
					))}
				</SidebarMenu>
			</SidebarGroup>
		</nav>
	);
}

function CloseMobileNavigation() {
	const { setOpenMobile } = useSidebar();
	return (
		<Button
			type="button"
			variant="ghost"
			size="icon"
			aria-label="Close navigation"
			className="md:hidden"
			onClick={() => setOpenMobile(false)}
		>
			<X aria-hidden="true" />
		</Button>
	);
}

function StaffToolbar() {
	const { isMobile, open, openMobile } = useSidebar();
	return (
		<header className="min-h-16 border-b bg-card">
			<div className="flex min-h-16 items-center gap-3 px-4 md:px-3">
				<SidebarTrigger
					size="icon"
					aria-label="Toggle navigation"
					aria-expanded={isMobile ? openMobile : open}
				/>
				<span className="font-semibold md:hidden">Interview Studio</span>
			</div>
		</header>
	);
}

export function StaffLayout() {
	const viewer = staffRoute.useLoaderData();
	return (
		<SidebarProvider>
			<Sidebar collapsible="icon">
				<SidebarHeader className="h-16 flex-row items-center justify-between">
					<div className="flex min-w-0 items-center gap-2 font-bold tracking-tight">
						<span className="flex size-8 shrink-0 items-center justify-center rounded-sm bg-sidebar-accent text-sidebar-accent-foreground">
							<PanelsTopLeft className="size-4" aria-hidden="true" />
						</span>
						<span className="truncate group-data-[collapsible=icon]:hidden">
							Interview Studio
						</span>
					</div>
					<CloseMobileNavigation />
				</SidebarHeader>
				<SidebarSeparator />
				<SidebarContent className="pt-3">
					<WorkspaceNavigation role={viewer.role} />
				</SidebarContent>
				<SidebarSeparator />
				<SidebarFooter>
					<StaffAccountMenu viewer={viewer} />
				</SidebarFooter>
			</Sidebar>
			<SidebarInset className="min-w-0">
				<StaffToolbar />
				<Outlet />
			</SidebarInset>
		</SidebarProvider>
	);
}
