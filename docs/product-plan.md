# Interview Studio v1 product plan

Interview Studio helps an internal hiring team run an interview drive from resume intake through a recorded L2 decision. HR owns coordination, one assigned panelist owns each round, and directors oversee progress and results. AI helps interviewers prepare questions and organize evidence. Panelists supply the ratings and make the decisions.

## People and access

| Role | Access and responsibilities |
| --- | --- |
| Director | View all drives, dashboards, candidate results, and submitted assessments. Manage staff roles. |
| HR | Coordinate all drives in a shared workspace. Manage job descriptions, candidate records, assignments, schedules, and invitations. Read submitted feedback. |
| Panelist | Prepare for assigned rounds, view candidate work live, and submit feedback. L1 and L2 are assignments for a round. The assigned L2 panelist can also read submitted L1 feedback. |
| Candidate | Join one scheduled round through a private link without creating an account. Use the coding workspace and whiteboard. |

Staff register with their name, work email, phone number, and password. Activation requires verification of a mailbox on the organization's approved PwC domain list. Provide password reset. A predesignated, verified email address receives the first director role. Other new staff start as panelists. Directors can grant HR or director access.

## Drive setup and interview preparation

1. **Create a drive.** HR gives the drive a name and uploads the job description for one hiring requirement. A drive can cover a batch or a single candidate, can span dates, and can overlap with other drives.
2. **Review candidate intake.** HR uploads resumes individually or in a batch. Studio extracts draft records containing name, email, experience, and a reference to the source resume. HR can correct missing or inaccurate details and resolve duplicate emails within the drive. If extraction fails, HR can still read the resume and enter the details manually. A confirmed name and email are required to schedule.
3. **Prepare the rounds.** Studio proposes skills from the job description for shared L1 and L2 scorecards. HR reviews them once per drive so candidates for the same role are assessed consistently. Studio uses each resume and the job description to suggest candidate-specific questions. Panelists can edit, skip, or add questions.

## Scheduling, invitations, and session access

- HR schedules one round at a time and assigns one panelist. Each booking has a start time, duration, time zone, and interview mode. HR supplies a Teams link for a virtual round or a room for an in-person round. When time slots overlap, Studio warns HR if either the confirmed candidate email or assigned panelist matches a booking in any drive. Email matching ignores surrounding spaces and case. HR can still book the round. Each drive keeps its own candidacy, assessments, and outcome.
- Studio generates invitation text with the round, local time and time zone, private Studio link, and Teams link or room. HR shares it through existing channels. HR can reassign an upcoming round, reschedule or cancel it, mark a no-show, or record a withdrawal. Rescheduling, cancellation, withdrawal, a no-show, or link replacement invalidates the previous invitation. L2 gets a fresh link.
- The candidate enters the invited email and confirms their name and years of experience. The invitation gives access to a single round and supports reconnection. The default entry window opens 10 minutes before the scheduled start. First entry is available until the scheduled end. After validation the candidate waits for the assigned panelist to start the round with them present. An admitted candidate can reconnect throughout an active round, including during overtime.
- Refreshing, closing a tab, or losing the connection preserves the active session and saved work. Either participant can explicitly end the interview after confirmation. HR can close an abandoned session. Closing disables candidate access immediately, preserves the work for staff review, and moves the round to **Awaiting feedback**.

## Interview workspace

| Capability | v1 behavior |
| --- | --- |
| Coding | The candidate writes a single-file JavaScript, Java, or Python program and can supply text input. Enable isolated execution with resource limits only for trusted internal participants using synthetic data on the pilot VM. Editing, saving, and manual feedback remain available when execution is disabled. Show output, compilation or runtime errors, and timeouts. Autosave the latest source. For each run, save the source, input, and result together. |
| Whiteboard | Support freehand drawing, basic shapes, text, erase, and undo. Autosave the drawing and restore it on reconnect. |
| Live panelist view | The candidate edits. The panelist can follow the code, run results, and whiteboard as they change. For virtual interviews, Teams handles the call and screen sharing. |
| Monitoring | In a virtual interview, the panelist can record an observed concern with context. In person, use ordinary interview notes. |

### Live transcription and AI assistance

- Explain what Studio captures, who can see it, and what is retained. Obtain agreement from both participants before capture, show when the microphone is active, and let either person stop capture. If either device loses its control connection, pause transcription on both devices, release the microphones, and discard buffered audio. Resuming requires both participants to agree again and Studio to confirm that the round is still active. If someone declines, capture stops, or a service fails, the panelist can continue with manual notes and submit the scorecard.
- For a virtual interview, both participants open Studio on their call devices and allow microphone capture. Studio captures each microphone separately. For an in-person interview, use one shared microphone. Flag uncertain speaker attribution for panelist review.
- Show suggested follow-up questions privately to the panelist. The panelist can mark a suggested question as asked or record their own question and attach manual notes. Draft feedback for the questions actually asked, grouped by skill, citing answers, code, or drawings where available. Identify missing evidence, summarize the interview, and suggest areas for further validation. The panelist can edit or discard any suggestion and choose the evidence that becomes part of the submitted assessment. A scorecard citation opens the exact code or drawing revision the panelist reviewed for as long as that assessment is retained. Private notes, ratings, and suggestions are visible only to authorized staff.
- Audio is processed for transcription without storing a recording. While feedback is pending, keep the temporary transcript available to the assigned panelist. On submission, delete the full transcript and every unapproved transcript-derived draft, including dismissed and untouched suggestions. Retain reviewed feedback, approved excerpts, code, run results, and the whiteboard. Before the full pilot rehearsal, the organization verifies the account settings and deletion timing for copies held by both text and speech providers. This approval is also required before sending either service real resumes or interview content. Apply the organization’s retention periods to completed records and expire temporary material for abandoned rounds and feedback drafts.

## Assessments and outcomes

| Round | Focus | Panelist decision and next step |
| --- | --- | --- |
| L1 | Programming fundamentals, algorithms, data structures, and role-relevant stack skills. | **Pass** puts the candidate in HR's **Ready for L2** queue. **Do not proceed** closes the candidacy for this drive. |
| L2 | Role- and experience-appropriate system design, architecture, behavioral questions, and production scenarios. The assigned panelist receives the submitted L1 scorecard and suggested follow-up questions for unresolved L1 evidence. | **Selected** or **Not selected** records the final hiring interview outcome for this drive. |

If an interruption leaves too little evidence for a decision, the panelist can submit **Incomplete** with a reason for either round. HR can then schedule a fresh attempt at the same level with a new invitation. Preserve the interrupted attempt and its work. Count only selection decisions in outcome totals.

For each skill, the panelist records **Below expectations**, **Meets expectations**, **Exceeds expectations**, or **Not assessed**. Submission requires a short rationale for the decision. Record the panelist and submission time. A correction requires a reason and preserves the earlier decision. Notify HR of an L1 correction that affects an existing L2.

If the corrected L1 changes from **Pass** to **Do not proceed** or **Incomplete** after L2 is booked, show **Pending HR review** to HR and directors and exclude the candidacy from outcome totals. Cancel an unfinished L2, stop any active capture, revoke its invitation and sessions, and preserve its work. Keep a submitted L2 scorecard available as history. L2 booking and entry remain closed until HR resolves the review.

HR checks the assessment versions and can ask the L1 panelist to reconsider. To resolve the review, HR records a reason and applies the latest L1 decision. **Do not proceed** closes the candidacy. **Incomplete** returns it to HR for a fresh L1. If the panelist restores **Pass** before resolution, HR can reinstate a submitted L2 decision or book a fresh L2 with a new link for an unfinished round. A reinstated **Incomplete** L2 follows the usual same-level rebooking rule. Only panelists change assessment decisions.

## Coordination and director dashboard

HR can identify candidates awaiting scheduling, active interviews, rounds awaiting feedback, candidates ready for L2, and completed outcomes. Directors can filter by drive, date, round, and outcome, then open the submitted assessment. Keep candidate progress specific to each drive. Count each candidate once per drive in outcome totals and show cancellations, no-shows, and withdrawals separately from assessment decisions.

## Launch acceptance

The pilot uses trusted internal participants in both roles and synthetic candidate data. The manual workflow is verified after the first two checks. Full pilot sign-off requires all four checks and verified provider settings and deletion timing.

1. **Complete a drive.** Import several resumes, recover one failed extraction, resolve a duplicate, schedule L1, and share an invitation. Submit an L1 pass, schedule L2, and submit a final outcome. A director can trace the result to both scorecards. An L1 rejection closes that candidacy. Reverse an L1 pass after L2 booking and after L2 submission. Check the old link, the review queue, the retained scorecards, and the director’s totals before and after HR resolution.
2. **Check access and scheduling.** Book the same confirmed email in overlapping slots in two drives and verify the HR warning and independent candidacies. Exercise panelist overlaps, incorrect candidate email, early arrival, revoked invitations, no-shows, overtime reconnects, and closure by either participant. Close an interrupted L1 as incomplete and rebook it without recording a hiring outcome. Verify that a closed link cannot retrieve saved work and that an unrelated panelist cannot open the record.
3. **Pilot both interview modes.** Use Teams with headsets and test an in-person interview with a shared microphone. Verify capture quality, duplicate or uncertain speech handling, withdrawal and closure while the other device is offline, and manual assessment when transcription or AI is unavailable.
4. **Verify evidence and retention.** Verify isolation and run successful, failing, and timed-out programs in all three languages on the pilot VM. Measure caption and follow-up delays during a Java run. Recover saved code and drawings after reconnecting. Cite revision A, save revision B, and open A from the submitted scorecard. Submit with an approved excerpt, a dismissed draft, and an untouched draft. Restore a backup taken before closure and submission. Before reopening Studio, verify that the old invitation and session are denied, the full transcript and both unapproved drafts are gone, approved evidence survives, and expired records stay inaccessible. Exercise expiry on an abandoned feedback draft.

Before the pilot, the organization supplies the approved staff email domains, first director email, approved AI and transcription provider settings, and retention periods. The 10-minute entry window and rating labels are v1 defaults.

Native video, automatic calendar invitations, multiple evaluators per round, graded challenge banks, automated misconduct detection, and automated candidate ranking are deferred.
