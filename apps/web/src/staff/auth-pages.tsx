import {
	passwordSchema,
	staffSignupSchema,
	workEmailSchema,
} from "@studio/contracts";
import { getRouteApi, Link, useRouterState } from "@tanstack/react-router";
import {
	CircleAlert,
	CircleCheck,
	LoaderCircle,
	MailCheck,
} from "lucide-react";
import { type ReactNode, useState } from "react";
import { z } from "zod";
import { Alert, AlertTitle } from "@/components/ui/alert";
import { Button, buttonVariants } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { authClient, authError } from "./auth-client.ts";
import { StaffForm, type StaffFormField } from "./auth-form.tsx";

const emailField = {
	name: "email",
	label: "Work email",
	type: "email",
	autoComplete: "username",
} as const;
const passwordField = {
	name: "password",
	label: "Password",
	type: "password",
	autoComplete: "current-password",
} as const;
const newPasswordField = {
	...passwordField,
	autoComplete: "new-password",
	description: "Use at least 12 characters.",
};
const registrationFields: StaffFormField[] = [
	{ name: "name", label: "Full name", autoComplete: "name" },
	emailField,
	{
		name: "phone",
		label: "Phone number",
		type: "tel",
		autoComplete: "tel",
		description: "Include a country code if applicable.",
	},
	newPasswordField,
];
const emailOnly = z.object({ email: workEmailSchema });
const credentials = emailOnly.extend({
	password: z.string().min(1, "Enter your password.").max(128),
});
const resetFields = [
	{ ...newPasswordField, label: "New password" },
	{
		...newPasswordField,
		name: "confirmation",
		label: "Confirm new password",
		description: undefined,
	},
];
const resetSchema = z
	.object({
		password: passwordSchema,
		confirmation: z.string(),
	})
	.refine((data) => data.password === data.confirmation, {
		path: ["confirmation"],
		message: "The passwords must match.",
	});

function AuthPanel({
	title,
	description,
	children,
	footer,
	showMailIcon = false,
}: {
	title: string;
	description: string;
	children: ReactNode;
	footer?: ReactNode;
	showMailIcon?: boolean;
}) {
	return (
		<section
			aria-labelledby="auth-heading"
			className="flex min-w-0 flex-col gap-6 sm:gap-7"
		>
			<div className="flex flex-col gap-2">
				{showMailIcon && (
					<div className="mb-2 grid size-11 place-items-center rounded-md bg-accent text-accent-foreground">
						<MailCheck aria-hidden="true" className="size-5" />
					</div>
				)}
				<h1
					id="auth-heading"
					className="text-3xl leading-tight font-bold tracking-tight text-balance sm:text-4xl"
				>
					{title}
				</h1>
				<p className="max-w-[36ch] text-base leading-relaxed text-muted-foreground">
					{description}
				</p>
			</div>
			<div className="flex flex-col gap-4">{children}</div>
			{footer && (
				<div className="flex flex-col gap-4 text-sm text-muted-foreground">
					<Separator />
					{footer}
				</div>
			)}
		</section>
	);
}

export function SignIn() {
	const { invitationId } = getRouteApi("/_auth/sign-in").useSearch();
	const query = new URLSearchParams(window.location.search);
	const notice = query.has("error")
		? "This verification link is invalid or expired. Request a new one."
		: query.get("verified") === "1"
			? "Email verified. Sign in to continue."
			: query.get("reset") === "1"
				? "Password changed. Sign in with your new password."
				: "";
	return (
		<AuthPanel
			title="Staff sign in"
			description="Use your verified work email to continue."
			footer={
				<p>
					New to Interview Studio?{" "}
					<Link to="/sign-up" className="font-semibold">
						Create an account
					</Link>
				</p>
			}
		>
			{notice && (
				<Alert
					role={query.has("error") ? "alert" : "status"}
					variant={query.has("error") ? "destructive" : "success"}
				>
					{query.has("error") ? (
						<CircleAlert aria-hidden="true" />
					) : (
						<CircleCheck aria-hidden="true" />
					)}
					<AlertTitle>{notice}</AlertTitle>
				</Alert>
			)}
			<StaffForm
				action="Sign in"
				pendingAction="Signing in…"
				schema={credentials}
				fields={[emailField, passwordField]}
				submit={async (data) => {
					const { error } = await authClient.signIn.email(data);
					if (error)
						return authError(
							error.status,
							error.code,
							"The email or password is incorrect.",
						);
					window.location.replace(
						invitationId
							? `/staff/my-interviews/invitations/${invitationId}`
							: "/staff",
					);
				}}
			/>
			<p className="flex flex-wrap justify-between gap-x-4 gap-y-2 text-sm">
				<Link to="/forgot-password">Forgot password?</Link>
				<Link to="/verify-email">Resend verification email</Link>
			</p>
		</AuthPanel>
	);
}

export function SignUp() {
	return (
		<AuthPanel
			title="Create a staff account"
			description="Register with an approved work email, then verify it to sign in."
			footer={
				<p>
					Already registered? <Link to="/sign-in">Staff sign in</Link>
				</p>
			}
		>
			<StaffForm
				action="Create account"
				pendingAction="Creating account…"
				schema={staffSignupSchema}
				fields={registrationFields}
				submit={async (data) => {
					const { error } = await authClient.signUp.email(data);
					if (error)
						return authError(
							error.status,
							error.code,
							"We couldn’t create the account. Check your details and try again.",
						);
					window.location.assign("/verify-email");
				}}
			/>
		</AuthPanel>
	);
}

function ConfirmEmail({ token }: { token: string }) {
	const [pending, setPending] = useState(false);
	const [error, setError] = useState("");

	async function confirm() {
		setPending(true);
		setError("");
		try {
			const response = await fetch("/api/auth/confirm-email", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ token }),
			});
			if (response.ok) {
				window.location.replace("/sign-in?verified=1");
				return;
			}
			setError(
				response.status === 429
					? "Too many attempts. Wait a moment, then try again."
					: "This link is invalid or expired. Request a new link.",
			);
		} catch {
			setError(
				"We couldn’t verify your email. Check your connection and try again.",
			);
		} finally {
			setPending(false);
		}
	}

	return (
		<AuthPanel
			title="Verify your work email"
			showMailIcon
			description="Confirm your work email to activate your staff account."
			footer={
				<p>
					<Link to="/verify-email">Request a new link</Link>
				</p>
			}
		>
			{error && (
				<Alert variant="destructive">
					<CircleAlert aria-hidden="true" />
					<AlertTitle>{error}</AlertTitle>
				</Alert>
			)}
			<Button
				size="lg"
				type="button"
				disabled={pending}
				onClick={confirm}
				aria-busy={pending}
			>
				{pending && (
					<LoaderCircle
						data-icon="inline-start"
						aria-hidden="true"
						className="motion-safe:animate-spin"
					/>
				)}
				Verify email
			</Button>
		</AuthPanel>
	);
}

export function VerifyEmail() {
	const [sent, setSent] = useState(false);
	const token = useRouterState({
		select: ({ location }) =>
			new URLSearchParams(location.searchStr).get("token"),
	});
	if (token) return <ConfirmEmail token={token} />;
	return (
		<AuthPanel
			title="Check your inbox"
			showMailIcon
			description="Open the verification link in your work inbox. If you need a new link, enter your email below."
			footer={
				<p>
					<Link to="/sign-in">Back to sign in</Link>
				</p>
			}
		>
			{sent && (
				<Alert role="status">
					<AlertTitle>
						If verification is still needed, a new link is on its way.
					</AlertTitle>
				</Alert>
			)}
			<StaffForm
				action="Resend link"
				pendingAction="Sending link…"
				schema={emailOnly}
				fields={[emailField]}
				submit={async (data) => {
					const { error } = await authClient.sendVerificationEmail(data);
					if (error)
						return authError(
							error.status,
							error.code,
							"We couldn’t send the link. Try again.",
						);
					setSent(true);
				}}
			/>
		</AuthPanel>
	);
}

export function ForgotPassword() {
	const [sent, setSent] = useState(false);
	return (
		<AuthPanel
			title="Forgot password"
			description="Enter your work email to request a reset link."
			footer={
				<p>
					<Link to="/sign-in">Back to sign in</Link>
				</p>
			}
		>
			{sent && (
				<Alert role="status">
					<AlertTitle>
						If the email is registered and verified, a reset link is on its way.
					</AlertTitle>
				</Alert>
			)}
			<StaffForm
				action="Send reset link"
				pendingAction="Sending link…"
				schema={emailOnly}
				fields={[emailField]}
				submit={async (data) => {
					const { error } = await authClient.requestPasswordReset({
						...data,
						redirectTo: "/reset-password",
					});
					if (error)
						return authError(
							error.status,
							error.code,
							"We couldn’t send a reset link. Try again.",
						);
					setSent(true);
				}}
			/>
		</AuthPanel>
	);
}

export function ResetPassword() {
	const [token] = useState(() =>
		new URLSearchParams(window.location.search).get("token"),
	);
	const [invalid, setInvalid] = useState(!token);
	return (
		<AuthPanel
			title="Reset password"
			description="Choose a new password for your staff account."
			footer={
				<p>
					<Link to="/sign-in">Back to sign in</Link>
				</p>
			}
		>
			{invalid ? (
				<>
					<Alert variant="destructive">
						<CircleAlert aria-hidden="true" />
						<AlertTitle>
							This link is invalid, expired, or already used.
						</AlertTitle>
					</Alert>
					<Link
						to="/forgot-password"
						className={buttonVariants({ size: "lg" })}
					>
						Request a new link
					</Link>
				</>
			) : (
				<StaffForm
					action="Change password"
					pendingAction="Changing password…"
					schema={resetSchema}
					fields={resetFields}
					submit={async ({ password }) => {
						const { error } = await authClient.resetPassword({
							newPassword: password,
							token: token ?? "",
						});
						if (error?.code === "INVALID_TOKEN") {
							setInvalid(true);
							return;
						}
						if (error)
							return authError(
								error.status,
								error.code,
								"We couldn’t change your password. Try again.",
							);
						window.location.replace("/sign-in?reset=1");
					}}
				/>
			)}
		</AuthPanel>
	);
}
