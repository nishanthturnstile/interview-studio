# Slice 2 implementation plan

A staff member can register, verify their work email, sign in, and reset their password. The designated verified account becomes the first director and can grant staff roles from the app. Completing this flow on the Mac gives Slice 3 an authenticated HR workspace. [Requirements roadmap](../core/requirements-roadmap.md#2-give-staff-the-right-access) · [Product access rules](../core/product-plan.md#people-and-access)

## Local defaults

- Use the existing Compose stack, the synthetic domain `studio.test`, and `director@studio.test` as the configurable first director. Use `http://127.0.0.1:3000` as the canonical app origin and preserve same-origin API calls through the Vite development proxy.
- Each staff account has one current role and starts as a panelist after verification. Directors can promote a panelist to HR or director, and an HR user to director. Keep these transitions in one server-side policy.
- Keep the infrastructure status screen at `/` and add a **Staff sign in** link. Put the signed-in workspace at `/staff` and the director's role management screen at `/staff/access`.

## Implementation order

### 1. Add auth storage and local email

- Pin Better Auth and its Drizzle adapter to `1.7.28`. Use the matching `auth` CLI to generate the Drizzle schema for users, sessions, credential accounts, verification data, and the required phone field. Apply reviewed migrations through the existing Compose migration service. Verify a fresh database and an upgrade of the Slice 1 database with its fixture intact. [Better Auth Drizzle adapter](https://better-auth.com/docs/adapters/drizzle)
- Add Nodemailer and Mailpit using the versions in the architecture. Publish the Mailpit inbox at `127.0.0.1:8025` and use SMTP on port `1025` inside Compose. Extend `pnpm local:init` to add a generated auth secret and missing settings to existing local configuration while preserving the database and storage credentials. Scope the auth secret and SMTP settings to the app. [Architecture choices](../core/architecture.md#technology-choices) · [Mailpit configuration](https://mailpit.axllent.org/docs/configuration/)

### 2. Build registration, verification, and sign-in

- Mount Better Auth at `/api/auth/*` before the API fallback in Hono. Validate name, phone, work email, and password at the server boundary. Canonicalize the email and match the domain exactly against the configured allowlist. Require email verification before creating a session. Use an expiring link that opens a confirmation page, a resend action, and an explicit sign-in after verification. [Hono integration](https://better-auth.com/docs/integrations/hono) · [Email verification](https://better-auth.com/docs/concepts/email)
- Use database-backed sessions and host-only, `HttpOnly`, `SameSite=Lax` cookies. Require the `Secure` flag over HTTPS and allow HTTP cookies only in explicit loopback development mode. Keep Better Auth's origin checks enabled and check configured origins on Studio mutations. Enable login and email-request rate limits locally and test them through HTTP. Use a shared per-route limiter for the single-machine stack with client-supplied IP headers ignored. [Cookies](https://better-auth.com/docs/concepts/cookies) · [Rate limiting](https://better-auth.com/docs/concepts/rate-limit)
- Add sign-up, check-inbox, sign-in, and sign-out using the existing Base UI components and theme. Serve deep links directly through Hono so Mailpit links and page refresh work in the built app. Give form errors accessible labels, focus, and recovery actions. Preserve the health API and the status checks.

### 3. Bootstrap the director and enforce grants

- Store explicit staff grants separately from Better Auth's credential data. On the designated account's first verified sign-in, record a singleton bootstrap claim and director grant in one transaction. Make retries and concurrent sign-ins safe. Keep the claim in PostgreSQL so changing the configured email later cannot bootstrap a second director.
- Resolve the current session, verified email, approved domain, and current Studio role on protected requests. Add `GET /api/staff/me` for the signed-in shell. Restrict the staff list and role change API to directors. Resolve grant targets by user ID, require them to be verified and on an approved domain, and apply each permitted transition atomically. Record who granted the role and when. Return the new role on the target's next authenticated request, including an existing session.
- Show verified staff and their current roles in the director's access screen. Use the server-provided role to display navigation and grant options. Apply the same authorization to direct API calls so a panelist gets a forbidden response even with a valid session.

### 4. Add password reset and finish local acceptance

- Add forgot-password and reset screens. Give the same reset-request confirmation for known and unknown addresses. Use Better Auth's expiring reset links and revoke existing sessions when the password changes. Enable Drizzle adapter transactions so the token, password update, and session revocation commit together. Keep link tokens, credentials, and raw emails out of logs. [Password reset and session revocation](https://better-auth.com/docs/authentication/email-password#revoking-sessions-on-password-reset)
- Document how to run the stack, register the synthetic director, and open the Mailpit inbox. Run Biome, TypeScript, Vitest, the production build, Playwright, and the existing Compose smoke check.

## Acceptance checks

| Check | Expected result |
| --- | --- |
| Registration and mailbox verification | An off-domain address is rejected. An unverified account gets no usable staff session. Opening the Mailpit link leaves the account unverified until the user chooses **Verify email**. |
| Bootstrap and role grants | The configured verified account becomes the first director once. A second verified account starts as panelist. A director can grant HR in the UI and grant director access through the same flow. |
| Server authorization | A signed-in panelist cannot list staff or change roles by calling the API. A role change from an untrusted origin fails. A valid grant takes effect in the target's existing browser session. Signing out ends that session. |
| Password recovery | A verified user resets through Mailpit. A used or expired reset link fails. The old password and pre-reset sessions stop working. |
| Local reliability | An existing Slice 1 database migrates twice, its fixture survives, and a fresh instance passes the flow with synthetic users in separate browser contexts. Rate limits return HTTP 429 when exceeded. |

Use Vitest with PostgreSQL for bootstrap, grant policy, and session boundaries. Use Playwright with separate director and panelist contexts for the Mailpit and role-management flows.

Before a pilot with real users, configure the approved PwC domain list, designated director mailbox, HTTPS origin, and approved SMTP relay.
