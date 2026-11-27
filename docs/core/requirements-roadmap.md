# Interview Studio v1 requirements and implementation roadmap

Build in the order below. By slice 6, HR can take a candidate from resume intake to a final L2 decision, and a director can review the result. Slices 7–10 add the live workspace and AI to that working interview flow. Record the manual workflow milestone when slices 1–6 pass. Slice 11 signs off the full pilot for trusted internal participants using synthetic data.

Take one slice per implementation task. Deliver its screen, server-side permissions, stored data, and background work together wherever applicable. Use Vitest for workflow and database rules, and Playwright with separate browser sessions for staff and candidates. Tick each box after its acceptance checks pass. The detailed behavior and technology choices live in the [product plan](product-plan.md) and [architecture](architecture.md).

## 1. Set up the codebase and prove the environment

- Create a TypeScript pnpm workspace with a React/Vite+ web app, a Hono server and worker, and shared Zod contracts. Pin dependencies, commit the lockfile and Biome configuration, and document the commands to start, check, test, migrate, and seed. Extend the synthetic seed as each slice introduces records.
- Run the app and worker from the same image with Docker Compose, PostgreSQL, Drizzle migrations, pg-boss, and a private SeaweedFS S3 bucket. Hono serves the UI, API, and live connections from one origin. Start the services after migrations succeed. Add a health check, worker heartbeat, and Pino request IDs that follow jobs into the worker.
- On the existing Dokploy VM, expose only the app through HTTPS. Use synthetic fixtures to check WebSockets, microphone permission, text and transcription provider access, and the three runner toolchains. Record the host architecture, enforced runner limits, timings, and memory use for the pilot. On the pilot deployment, configure off-host database and object backups and durable off-host PostgreSQL write-ahead logging (WAL) for access changes, assessment submissions or corrections, and retention deletions. Slice 11 exercises recovery.

- [ ] **Done when** a fresh checkout starts from the documented commands, migrations and seed can run twice, a worker finishes a job, and a private test upload survives redeployment. Mac and Windows browsers can open the deployed app. Record the result of each feasibility check before enabling its feature.

## 2. Give staff the right access

- Use Better Auth for sign-up, verification, sign-in, and password reset. Collect name, work email, phone, and password. Verify an approved PwC mailbox before activation. Test mail in Mailpit and configure an approved SMTP relay for actual delivery.
- Give the predesignated verified address the first director role. Other verified staff start as panelists. Directors can grant HR or director access. Enforce roles on the server, use secure session cookies, check request origins, and rate-limit login attempts.

- [ ] **Done when** a director can grant HR access, a verified user can reset their password, an unverified or off-domain account cannot enter, and a panelist cannot grant roles through the API.

## 3. Let HR prepare a drive

- HR creates a named drive for one requirement, uploads its job description, and adds PDF or DOCX resumes individually or in a batch. Show intake status per file. Validate file type and size, bound parsing work, and authorize every download. Keep original files in SeaweedFS and their ownership, object keys, and checksums in PostgreSQL.
- Extract text with PDF.js or Mammoth in the worker. Give HR an editable record for each resume with name, email, experience, and access to the original. Allow manual entry after a parsing failure. Resolve duplicate emails within the drive and require a confirmed name and email before booking.
- Let HR define and review shared L1 and L2 scorecard skills. Slice 9 adds suggestions to these same screens.

- [ ] **Done when** HR can prepare a batch containing a duplicate and an unreadable resume, confirm the corrected records, and retrieve an original. A failed file leaves the rest usable, and anonymous access to the bucket is denied.

## 4. Schedule a round and admit the candidate

- HR books one round with one panelist, a start time, duration, time zone, and Teams link or room. Store the UTC time and display zone. On booking or rescheduling, warn HR of overlaps across drives by confirmed candidate email (trimmed and lowercased) or panelist ID. Keep the warning advisory and the candidacies separate. Generate invitation text HR can copy. Support reassignment, rescheduling, cancellation, link replacement, no-show, and withdrawal.
- The candidate joins without an account, enters the invited email, and confirms name and experience. Hash the invitation secret, rate-limit validation, and exchange it for a secure session scoped to one attempt. First entry opens 10 minutes before the start and ends at the scheduled end. The assigned panelist starts the interview with the candidate present.
- Either participant can confirm closure. HR can close an abandoned round. Closing moves the round to **Awaiting feedback**. Revoke old invitations and sessions on reschedule, cancellation, replacement, no-show, withdrawal, or closure. Reassignment removes the former panelist’s access.

- [ ] **Done when** an early arrival outside the window, a wrong email, and a revoked link are denied. Book overlapping slots in two drives using case variants of the same confirmed email. HR sees a warning and can proceed. Check panelist overlap separately. An admitted candidate can refresh and reconnect during overtime. Closure immediately ends candidate access, including any open live connection.

Local Slice 4 rehearsal passed with isolated PostgreSQL, Mailpit, and separate
staff and candidate browser sessions. The shared HTTPS origin and the full link
inside an actual Teams invitation still need verification. Live-connection
closure is part of the Slice 7 transport work.

## 5. Complete L1 and L2 manually

- Give the assigned panelist a private list of questions asked, manual notes, and a scorecard. Freeze each attempt’s criteria. For each skill, offer **Below expectations**, **Meets expectations**, **Exceeds expectations**, or **Not assessed**. Require the panelist’s decision and rationale, and store the author and submission time.
- L1 covers fundamentals and the relevant stack. **Pass** puts the candidate in **Ready for L2**, where HR books a fresh round and link. **Do not proceed** closes the candidacy. The assigned L2 panelist can read submitted L1 feedback, assess role-appropriate design, production, and behavioral skills, and record **Selected** or **Not selected**.
- Allow **Incomplete** with a reason at either level. Preserve the attempt and its work when HR rebooks. Corrections require a reason and preserve the prior decision. Notify HR when an L1 correction affects an existing L2.
- If a correction removes the L1 pass behind an existing L2, atomically put the candidacy in **Pending HR review**. Cancel any unfinished L2, revoke its invitation and sessions, and preserve its work. Block L2 booking and admission during review. Keep submitted L2 decisions as history. HR records a reason and applies the latest panelist decision. **Do not proceed** closes the candidacy and **Incomplete** allows a fresh L1. If a panelist restores the pass during review, HR can reinstate a submitted L2 decision or book a fresh L2 with a new invitation. A reinstated incomplete L2 allows rebooking at L2.

- [ ] **Done when** a candidate can complete both rounds with AI unavailable, an L1 rejection ends that candidacy, and an incomplete round can be rebooked without recording a hiring outcome. An unrelated panelist cannot open either assessment. Reverse a pass with a booked L2 and verify the old link and admitted session are denied. Repeat after an L2 selection and verify both scorecard histories survive HR resolution. Exercise a restored pass and verify the fresh invitation or reinstated decision.

## 6. Show progress and results

- Give HR queues for candidates awaiting scheduling, active interviews, feedback due, candidates ready for L2, L1 corrections pending HR review, and completed outcomes. HR can read submitted feedback across drives.
- Give directors filters for drive, date, round, and outcome, with links to submitted scorecards. Keep progress specific to each drive. Show cancellations, no-shows, and withdrawals separately from assessment decisions.

- [x] **Done when** a director can trace a final result to both scorecards, and a candidate with an incomplete attempt, a rebooking, or a corrected decision contributes at most one current outcome per drive. Verify the same email has independent progress and totals across two drives. When a correction removes the L1 pass behind an existing L2, directors see **Pending HR review** and zero current outcomes for that candidacy until HR resolves it. Then check the total against the resolution.

## 7. Add the live editor and whiteboard

- Load CodeMirror and Excalidraw on the interview screen. The candidate edits single-file code or draws with freehand strokes, shapes, text, erase, and undo. Offer JavaScript, Java, and Python with Hello World starters and separate saved drafts. The assigned panelist follows read-only. Both participants can open Code or Whiteboard full screen. Teams handles the virtual call and screen sharing. Let panelists record a concern with context in virtual rounds and ordinary notes in person.
- Autosave revisions in PostgreSQL, acknowledge committed saves, and send authorized updates over WebSocket. Restore the current revision on reconnect. Give each saved revision a stable ID so slice 10 can retain the exact revision cited by an assessment. Save pending edits before candidate-confirmed closure. Remote closure preserves the last acknowledged revision.

- [ ] **Done when** a candidate can edit on Windows while a panelist follows on Mac, a refresh restores code and drawings, a stale tab cannot overwrite newer work, and a closed candidate session cannot retrieve an artifact.

## 8. Run candidate code

- Accept JavaScript, Python, or Java source and text input. Save the exact source and input when queuing the run, then attach output, compilation or runtime errors, or timeout to that snapshot. Show the result to both participants. Make retries safe and reload committed results after a missed live notification.
- Use pg-boss and private go-judge on the existing Linux VM for the trusted internal pilot with synthetic data. Only the worker can reach the runner. Run one program at a time with fixed profiles, denied program networking, and CPU, time, memory, process, and output limits. Keep host data, secrets, and the Docker socket out of the runner. Check the round’s execution setting before queuing and again before dispatch.

- [ ] **Done when** all three languages pass success, error, timeout, and isolation checks on the VM. A repeated request creates one run, and the result is recoverable after a worker restart. Exercise the disabled state and verify that editing, saving, and manual feedback still work. Failed isolation leaves execution disabled, this slice open, and full pilot sign-off blocked.

## 9. Add AI-assisted preparation

- Use synthetic inputs for provider testing. The organization’s provider approver verifies and records account settings, applicable terms, and deletion timing for both text and speech before the full pilot rehearsal and before either provider processes real resumes or interview data.
- Use the worker and Vercel AI SDK with the approved OpenAI text model to draft candidate fields from resumes, shared L1/L2 skills from the job description, and questions from both documents. Validate draft fields on the server. HR confirms intake and criteria. The panelist can edit, skip, or add questions.
- Keep separate worker capacity for live jobs during batch intake. Record the task, prompt version, model, queue and provider timing, retries, validation, and status. Keep telemetry content-free and expire AI run metadata after 14 days by default.

- [ ] **Done when** HR can correct a suggested field before scheduling, a panelist can replace a suggested question, and one failed AI job leaves the manual path and the rest of the batch usable. An operator can trace the failure without seeing the resume or prompt.

## 10. Add consented transcription and interview assistance

- Explain capture, audience, and retention. Obtain both participants’ agreement, display actual capture status, and let either person stop it. Relay separate microphone streams for virtual rounds and one shared microphone in person through Hono to OpenAI Realtime. Keep audio in memory, flag gaps and uncertain speakers, and deduplicate finalized speech on reconnect. If either control connection drops or its heartbeat expires, stop both streams, release the microphones, clear buffered audio, and reject late frames. Resume only after fresh agreement from both participants and server confirmation of an active round.
- Show follow-ups privately to the panelist. For questions marked as asked, draft feedback by skill, cite answers or saved artifact revisions, summarize the interview, and identify missing evidence. Validate all evidence references against the attempt. For code and drawings, retain the immutable revision for every assessment version that cites it. The panelist can edit or discard drafts, approve excerpts, and carry unresolved L1 topics into L2. The panelist supplies all ratings and decisions.
- Keep the temporary transcript available to the assigned panelist while feedback is pending. On submission, save approved evidence and delete the full transcript and all unapproved transcript-derived drafts, including dismissed and untouched suggestions, in one transaction. Prevent late jobs from restoring them. Apply configured expiry to abandoned drafts, completed records, and unreferenced uploads.

- [ ] **Done when** both interview modes work, withdrawal or closure stops capture on both devices, and the panelist can finish manually after a refusal or outage. Disconnect one device and separately exercise withdrawal and closure on the other. Verify microphone release by the heartbeat deadline, accurate indicators, discarded buffers, and denial of stale audio after reconnect. Confirm capture can restart only in an active round with fresh agreement.
  - Cite revision A of code or a drawing, save B, and submit with an approved excerpt, a dismissed draft, and an untouched draft. A director opening the citation sees A. The excerpt survives, the transcript and both drafts stay deleted after a late job retry, and candidates cannot see private suggestions.

## 11. Verify the complete pilot

- Confirm the recorded text and speech approvals from slice 9 before starting the full pilot rehearsal. Run a synthetic drive on Dokploy from batch intake through L1, L2, and director review. Exercise Teams with headsets on Mac and Windows and a shared microphone in person. Check reconnects, revocation, and caption and follow-up delays while a Java program runs.
- Take a backup before closure and submission, then close the round and submit with an approved excerpt, a dismissed draft, and an untouched draft. Restore PostgreSQL and the bucket in isolation. Replay off-host WAL through the acknowledged changes, apply current expiry, and reconcile objects before starting an isolated retry worker. Check the revoked invitation and session, the retained excerpt and cited revision, absence of the transcript and both drafts after retry, and a retained download’s checksum. Keep ingress closed if recovery is incomplete.
- Confirm that logs exclude secrets, candidate details, prompts, and interview content. Trace a failed AI job in Dokploy, inspect slow queries with PostgreSQL statistics, and compare two prompt versions on the same synthetic evidence.
- Record the approved staff domains, first director email, SMTP relay, and organizational retention periods. Record the measured host limits and which pilot features passed. Revisit a separate runner VM before accepting untrusted submissions.

- [ ] **Done when** the manual milestone, synthetic drive, both audio modes, access checks, restore, retention, and provider approval checks pass, and the operator can identify a failing dependency from telemetry. Require passing isolation, success, error, and timeout checks for all three languages on the pilot VM and recorded caption and follow-up delays during a Java run. Record any failed check against its owning slice before marking the pilot complete.
