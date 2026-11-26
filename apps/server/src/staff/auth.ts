import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { passwordSchema, staffSignupSchema } from "@studio/contracts";
import { betterAuth } from "better-auth";
import { APIError, createAuthMiddleware } from "better-auth/api";
import type { db } from "../database.ts";
import { errorClass, logger } from "../logger.ts";
import { staffAuthFields } from "./auth-fields.ts";
import * as authSchema from "./auth-schema.ts";
import { bootstrapDirector, getStaff } from "./roles.ts";
import { isApprovedEmail, type StaffSettings } from "./settings.ts";

type SendMail = (to: string, subject: string, message: string) => void;

export function createStaffAuth(
	database: typeof db,
	settings: StaffSettings,
	sendMail: SendMail,
) {
	return betterAuth({
		baseURL: settings.origin,
		secret: settings.secret,
		trustedOrigins: settings.trustedOrigins,
		database: drizzleAdapter(database, {
			provider: "pg",
			schema: authSchema,
			transaction: true,
		}),
		user: { additionalFields: staffAuthFields },
		emailAndPassword: {
			enabled: true,
			requireEmailVerification: true,
			autoSignIn: false,
			minPasswordLength: passwordSchema.minLength ?? undefined,
			maxPasswordLength: passwordSchema.maxLength ?? undefined,
			resetPasswordTokenExpiresIn: 1_800,
			revokeSessionsOnPasswordReset: true,
			sendResetPassword: async ({ user, url }) => {
				if (
					user.emailVerified &&
					isApprovedEmail(user.email, settings.domains)
				) {
					sendMail(
						user.email,
						"Reset your Interview Studio password",
						`Choose a new password using this link:\n\n${url}\n\nThe link expires in 30 minutes.`,
					);
				}
			},
		},
		emailVerification: {
			sendOnSignUp: true,
			autoSignInAfterVerification: false,
			expiresIn: 3_600,
			sendVerificationEmail: async ({ user, token }) => {
				const url = new URL("/verify-email", settings.origin);
				url.searchParams.set("token", token);
				sendMail(
					user.email,
					"Verify your Interview Studio email",
					`Open this link and confirm your work email:\n\n${url}\n\nThen return to Interview Studio to sign in.`,
				);
			},
		},
		advanced: {
			cookiePrefix: "interview-studio",
			useSecureCookies: settings.secureCookies,
			ipAddress: { ipAddressHeaders: [] },
		},
		rateLimit: {
			enabled: true,
			storage: "memory",
			customRules: {
				"/sign-up/email": { window: 10, max: 5 },
				"/sign-in/email": { window: 10, max: 5 },
				"/send-verification-email": { window: 60, max: 5 },
				"/verify-email": { window: 10, max: 10 },
				"/request-password-reset": { window: 60, max: 5 },
				"/reset-password": { window: 60, max: 5 },
			},
		},
		logger: { disabled: true },
		onAPIError: {
			onError: (error) =>
				logger.warn(
					{ errorClass: errorClass(error) },
					"Staff authentication error",
				),
		},
		hooks: {
			before: createAuthMiddleware(async (context) => {
				if (context.path === "/sign-up/email") {
					const signup = staffSignupSchema.safeParse(context.body);
					if (!signup.success) {
						throw new APIError("BAD_REQUEST", {
							code: "INVALID_STAFF_PROFILE",
							message: "Check the required registration fields.",
						});
					}
					if (!isApprovedEmail(signup.data.email, settings.domains)) {
						throw new APIError("BAD_REQUEST", {
							code: "EMAIL_DOMAIN_NOT_ALLOWED",
							message: "Use a work email on an approved domain.",
						});
					}
					return { context: { body: signup.data } };
				}
				if (context.path === "/request-password-reset") {
					return {
						context: {
							body: {
								email: context.body.email,
								redirectTo: `${settings.origin}/reset-password`,
							},
						},
					};
				}
			}),
		},
		databaseHooks: {
			session: {
				create: {
					before: async (session) => {
						const staff = await getStaff(
							database,
							session.userId,
							settings.domains,
						);
						if (!staff) return false;
						if (staff.email === settings.directorEmail)
							await bootstrapDirector(database, staff.id);
					},
				},
			},
		},
	});
}
