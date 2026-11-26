import {
	type CandidateInterview,
	candidateInterviewSchema,
	confirmInterviewProfileSchema,
	interviewChallengeSchema,
	interviewCompleteSchema,
	interviewResultSchema,
} from "@studio/contracts";
import { getRouteApi, Link } from "@tanstack/react-router";
import {
	ArrowLeft,
	CircleCheck,
	Clock3,
	Mail,
	PanelsTopLeft,
	Video,
} from "lucide-react";
import {
	type FormEvent,
	type ReactNode,
	useEffect,
	useId,
	useRef,
	useState,
} from "react";
import type { z } from "zod";
import { ThemeButton } from "@/components/theme-button";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
} from "@/components/ui/card";
import {
	Field,
	FieldDescription,
	FieldGroup,
	FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
	InterviewRequestError,
	interviewRequest,
	useCommandKey,
	useInterviewPoll,
} from "./api";
import { InterviewAlert, InterviewLoading, ScheduleCard } from "./display";
import { EndInterviewDialog } from "./end-dialog";
import {
	forgetInvitationFragment,
	invitationFragment,
} from "./invitation-fragment";

function CandidateShell({ children }: { children: ReactNode }) {
	return (
		<>
			<header className="border-b bg-card">
				<div className="mx-auto flex min-h-16 max-w-5xl items-center justify-between gap-4 px-4 sm:px-8">
					<span className="flex items-center gap-2 font-bold tracking-tight">
						<span className="grid size-8 place-items-center rounded-md bg-accent text-accent-foreground">
							<PanelsTopLeft className="size-4" aria-hidden="true" />
						</span>
						Interview Studio
					</span>
					<ThemeButton />
				</div>
			</header>
			<main className="mx-auto flex w-full max-w-xl flex-col gap-4 px-4 py-10 sm:px-8 sm:py-16">
				{children}
			</main>
		</>
	);
}

function CandidateCard({
	title,
	description,
	children,
	icon: Icon = Video,
}: {
	title: string;
	description: string;
	children?: ReactNode;
	icon?: typeof Video;
}) {
	return (
		<Card>
			<CardHeader className="gap-3">
				<div className="grid size-10 place-items-center rounded-md bg-accent text-accent-foreground">
					<Icon className="size-5" aria-hidden="true" />
				</div>
				<h1 className="text-2xl font-bold tracking-tight sm:text-3xl">
					{title}
				</h1>
				<CardDescription className="max-w-[45ch] text-sm leading-relaxed sm:text-base">
					{description}
				</CardDescription>
			</CardHeader>
			{children && (
				<CardContent className="flex flex-col gap-4">{children}</CardContent>
			)}
		</Card>
	);
}

const joinRoute = getRouteApi("/join/$invitationId");

export function JoinInterview() {
	const { invitationId } = joinRoute.useParams();
	const [secret, setSecret] = useState(() => invitationFragment(invitationId));
	const [joining, setJoining] = useState(false);
	useEffect(() => {
		const refresh = () => setSecret(invitationFragment(invitationId));
		refresh();
		window.addEventListener("hashchange", refresh);
		return () => window.removeEventListener("hashchange", refresh);
	}, [invitationId]);
	return (
		<CandidateShell>
			{joining && secret ? (
				<MailboxForm
					key={invitationId}
					id={invitationId}
					secret={secret}
					onBack={() => setJoining(false)}
				/>
			) : (
				<CandidateCard
					title="Join an interview"
					description="Candidates can verify their invited email here. Staff can sign in with their work account."
				>
					<div className="flex flex-col gap-2 sm:flex-row">
						<Button onClick={() => setJoining(true)} disabled={!secret}>
							Join as candidate
						</Button>
						<Link
							to="/staff/my-interviews/invitations/$invitationId"
							params={{ invitationId }}
							className={buttonVariants({ variant: "outline" })}
						>
							Staff sign-in
						</Link>
					</div>
					{!secret && (
						<p className="text-sm text-muted-foreground">
							Reopen the full Studio link from your invitation to join as a
							candidate.
						</p>
					)}
				</CandidateCard>
			)}
		</CandidateShell>
	);
}

type Challenge = z.infer<typeof interviewChallengeSchema>;
function MailboxForm({
	id,
	secret,
	onBack,
}: {
	id: string;
	secret: string;
	onBack: () => void;
}) {
	const navigate = joinRoute.useNavigate();
	const emailId = useId();
	const codeId = useId();
	const codeInput = useRef<HTMLInputElement>(null);
	const [email, setEmail] = useState("");
	const [code, setCode] = useState("");
	const [challenge, setChallenge] = useState<Challenge>();
	const [error, setError] = useState<unknown>();
	const [busy, setBusy] = useState(false);
	const [now, setNow] = useState(Date.now);
	const [retryAt, setRetryAt] = useState(0);
	const resendAt = Math.max(
		challenge ? Date.parse(challenge.resendAt) : 0,
		retryAt,
	);
	const remaining = Math.max(0, Math.ceil((resendAt - now) / 1_000));
	useEffect(() => {
		if (Date.now() >= resendAt) return;
		const timer = window.setInterval(() => {
			const current = Date.now();
			setNow(current);
			if (current >= resendAt) window.clearInterval(timer);
		}, 1_000);
		return () => window.clearInterval(timer);
	}, [resendAt]);
	useEffect(() => {
		if (challenge && !busy) codeInput.current?.focus();
	}, [challenge, busy]);
	async function send() {
		const next = await interviewRequest(
			`/interviews/invitations/${id}/code`,
			interviewChallengeSchema,
			{ data: { email, secret } },
		);
		setNow(Date.now());
		setCode("");
		setChallenge(next);
	}
	async function run(action: () => Promise<void>) {
		if (busy) return;
		setError(undefined);
		setBusy(true);
		try {
			await action();
		} catch (error) {
			setError(error);
			if (error instanceof InterviewRequestError && error.problem?.retryAfter) {
				setNow(Date.now());
				setRetryAt(Date.now() + error.problem.retryAfter * 1_000);
			}
		} finally {
			setBusy(false);
		}
	}
	async function verify() {
		const { id: roundId } = await interviewRequest(
			`/interviews/invitations/${id}/verify`,
			interviewResultSchema,
			{
				data: { challengeId: challenge?.challengeId, email, secret, code },
			},
		);
		forgetInvitationFragment();
		await navigate({
			to: "/interview/$roundId",
			params: { roundId },
			replace: true,
		});
	}
	return (
		<CandidateCard
			title={challenge ? "Enter your email code" : "Verify your email"}
			description={
				challenge
					? "Enter the six-digit code sent to your invited email address."
					: "Use the same email address where you received the interview invitation."
			}
			icon={Mail}
		>
			<form
				className="flex flex-col gap-4"
				onSubmit={(event) => {
					event.preventDefault();
					void run(challenge ? verify : send);
				}}
			>
				<FieldGroup>
					{challenge ? (
						<Field>
							<FieldLabel htmlFor={codeId}>Verification code</FieldLabel>
							<Input
								id={codeId}
								disabled={busy}
								ref={codeInput}
								required
								value={code}
								onChange={(event) =>
									setCode(event.target.value.replace(/\D/g, "").slice(0, 6))
								}
								inputMode="numeric"
								autoComplete="one-time-code"
								pattern="[0-9]{6}"
								maxLength={6}
								className="font-mono tracking-widest"
							/>
							<FieldDescription className="[overflow-wrap:anywhere]">
								{email}
							</FieldDescription>
						</Field>
					) : (
						<Field>
							<FieldLabel htmlFor={emailId}>Invited email</FieldLabel>
							<Input
								id={emailId}
								disabled={busy}
								type="email"
								autoComplete="email"
								value={email}
								onChange={(event) => setEmail(event.target.value)}
								required
								maxLength={254}
							/>
						</Field>
					)}
				</FieldGroup>
				{error !== undefined && <InterviewAlert error={error} />}
				<Button type="submit" disabled={busy || (!challenge && remaining > 0)}>
					{busy ? "Please wait…" : challenge ? "Verify code" : "Send code"}
				</Button>
				{challenge && (
					<Button
						type="button"
						variant="outline"
						disabled={busy || remaining > 0}
						onClick={() => void run(send)}
					>
						{remaining ? `Resend code in ${remaining}s` : "Resend code"}
					</Button>
				)}
				<Button
					variant="ghost"
					className="self-start"
					type="button"
					disabled={busy}
					onClick={() => {
						if (challenge) {
							setChallenge(undefined);
							setError(undefined);
						} else onBack();
					}}
				>
					<ArrowLeft data-icon="inline-start" />
					{challenge ? "Change email" : "Back"}
				</Button>
			</form>
		</CandidateCard>
	);
}

function ProfileForm({
	round,
	onConfirmed,
}: {
	round: CandidateInterview;
	onConfirmed: () => void;
}) {
	const id = useId();
	const [name, setName] = useState(round.candidate.name);
	const [experience, setExperience] = useState(
		round.candidate.years?.toString() ?? "",
	);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<unknown>();
	async function save(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		if (busy) return;
		const profile = confirmInterviewProfileSchema.safeParse({
			name,
			years: experience === "" ? null : Number(experience),
		});
		if (!profile.success) {
			setError(new InterviewRequestError(400, { error: "invalid_input" }));
			return;
		}
		setBusy(true);
		try {
			await interviewRequest(
				`/interviews/rounds/${round.id}/profile`,
				candidateInterviewSchema,
				{ data: profile.data },
			);
			onConfirmed();
		} catch (error) {
			setError(error);
		} finally {
			setBusy(false);
		}
	}
	return (
		<CandidateCard
			title="Confirm your details"
			description="Check your name and experience before you enter the waiting room."
			icon={CircleCheck}
		>
			<form onSubmit={save} className="flex flex-col gap-4">
				<fieldset disabled={busy}>
					<FieldGroup>
						<Field>
							<FieldLabel htmlFor={`${id}-name`}>Full name</FieldLabel>
							<Input
								id={`${id}-name`}
								autoComplete="name"
								value={name}
								onChange={(event) => setName(event.target.value)}
								required
								maxLength={120}
							/>
						</Field>
						<Field>
							<FieldLabel htmlFor={`${id}-experience`}>
								Years of experience
							</FieldLabel>
							<Input
								id={`${id}-experience`}
								type="number"
								step={0.1}
								min={0}
								max={80}
								value={experience}
								onChange={(event) => setExperience(event.target.value)}
							/>
							<FieldDescription>Leave blank if unknown.</FieldDescription>
						</Field>
					</FieldGroup>
				</fieldset>
				{error !== undefined && <InterviewAlert error={error} />}
				<Button type="submit" disabled={busy}>
					{busy ? "Joining…" : "Confirm and join"}
				</Button>
			</form>
		</CandidateCard>
	);
}

const candidateRoute = getRouteApi("/interview/$roundId");

export function CandidateRound() {
	const { roundId } = candidateRoute.useParams();
	const [finished, setFinished] = useState(false);
	const [confirming, setConfirming] = useState(false);
	const [busy, setBusy] = useState(false);
	const [commandError, setCommandError] = useState<unknown>();
	const [refresh, setRefresh] = useState(0);
	const withKey = useCommandKey();
	const path = `/interviews/rounds/${roundId}`;
	const resource = useInterviewPoll(
		finished ? null : path,
		candidateInterviewSchema,
		{ candidate: true, refresh },
	);
	const round = resource?.data;
	async function end() {
		if (!round || busy) return;
		setBusy(true);
		setCommandError(undefined);
		try {
			await interviewRequest(`${path}/end`, interviewCompleteSchema, {
				data: withKey({ revision: round.revision }),
			});
			setFinished(true);
		} catch (error) {
			setCommandError(error);
			if (
				error instanceof InterviewRequestError &&
				[404, 409].includes(error.status)
			)
				setRefresh((value) => value + 1);
		} finally {
			setBusy(false);
		}
	}
	const unavailable = finished || resource?.terminal;
	return (
		<CandidateShell>
			{unavailable ? (
				<CandidateCard
					title="Interview ended or unavailable"
					description="You can close this tab. Contact your interview coordinator if you need help."
					icon={CircleCheck}
				/>
			) : !round ? (
				resource?.error !== undefined ? (
					<InterviewAlert error={resource.error} />
				) : (
					<InterviewLoading />
				)
			) : !round.confirmed ? (
				<ProfileForm
					key={round.id}
					round={round}
					onConfirmed={() => setRefresh((value) => value + 1)}
				/>
			) : (
				<>
					<CandidateCard
						title={
							round.state === "active"
								? "Interview in progress"
								: "You’re in the waiting room"
						}
						description={
							round.state === "active"
								? "Your panelist has started the interview. Use the meeting details below to join them."
								: "Keep this tab open. Your panelist will see that you’ve arrived and can start the round."
						}
						icon={round.state === "active" ? Video : Clock3}
					>
						<div role="status">
							<Badge variant={round.state === "active" ? "success" : "info"}>
								{round.state === "active" ? "Active" : "Waiting for panelist"}
							</Badge>
						</div>
						{resource?.error !== undefined && (
							<InterviewAlert error={resource.error} />
						)}
						{round.state === "active" && (
							<div>
								<EndInterviewDialog
									open={confirming}
									setOpen={(value) => {
										setConfirming(value);
										setCommandError(undefined);
									}}
									pending={busy}
									error={commandError}
									onEnd={() => void end()}
									candidate
								/>
							</div>
						)}
					</CandidateCard>
					<ScheduleCard
						round={round}
						title={`${round.level.toUpperCase()} interview`}
					/>
				</>
			)}
		</CandidateShell>
	);
}
