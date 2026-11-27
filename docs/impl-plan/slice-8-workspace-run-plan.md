# Slice 8 code execution plan

Run extends the editor and whiteboard delivered in [Slice 7](slice-7-implementation-plan.md).

## 1. Run the current program

Put Run next to the candidate language selector and show the latest output underneath the editor. Offer optional text input in a disclosure. Label the result with its language and indicate when it came from earlier code or input. Render output as plain text. Let the assigned panelist follow the latest result. Save the exact source and input at the time Run is pressed. Queue the job and record the run in the same transaction. Reject reuse of a command ID with different code or input. Enforce one unfinished run per round in the database. Verify result reads and run transitions with a fake runner.

## 2. Connect the private worker runner

Use the existing pg-boss worker pattern and the private go-judge service specified in the roadmap. Keep execution off by default. Check the round and environment flags at submission and again before dispatch. Use runner-wide and queue limits to serialize execution. Use fixed profiles and hard resource limits. Treat compile errors, runtime errors, and timeouts as program results. Persist the terminal result before acknowledging the job. If the worker recovers a job after it may have dispatched, mark it interrupted. Retain the normal editing and feedback paths when execution is unavailable.

The Compose profile `code-execution` starts the runner on a private network shared with the worker. Configure `STUDIO_GO_JUDGE_TOKEN` on the runner and worker. The worker uses `http://runner:5050` by default. After target VM validation, set `STUDIO_CODE_EXECUTION_ENABLED=true` for the app and worker and set `interview_round.code_execution_enabled` to true on the approved pilot rounds. Java uses separate compile and run limits. Temporary compiled archives expire and the worker deletes them after use.

## Verification

Check three-language success, errors and timeouts, duplicate submissions, access control, result reload, and editing and feedback with execution disabled. Keep pilot execution disabled until isolation and restart checks pass on the target Linux VM.

PostgreSQL integration covered transactional queuing, retry deduplication, and interrupted runs. The candidate browser check covered submitted input and source and output recovery on reload with intercepted run requests. The local Linux runner passed all three starter, input, error, timeout, and isolation checks. Target VM verification and rollout remain pending.
