# Interview Studio

## Start on macOS

If you use Colima, start it before running Docker Compose. Confirm that
`docker context show` reports `colima`.

```sh
colima start
```

From the project root, install dependencies and start the stack.

```sh
mise trust
mise install
mise exec -- pnpm install --frozen-lockfile
mise exec -- pnpm local:init
docker compose up -d --build --wait
```

Open [Interview Studio](http://127.0.0.1:3000). The page checks the database,
worker heartbeat, and private bucket through the same-origin API. The app
listens on loopback. PostgreSQL and SeaweedFS have no published host ports.

`local:init` creates an ignored `.env` with random local credentials on the
first run and reuses it on subsequent runs. Keep it with the local volumes.
Change `STUDIO_PORT` in `.env` if port 3000 is in use.

## Develop and verify

Run `mise exec -- pnpm dev` while Compose is up. Open
[the hot-reload server](http://127.0.0.1:5173), which proxies `/api` to the
local Hono process. For a custom app port, set `STUDIO_API_ORIGIN` to that
loopback origin when starting Vite+. Rebuild Compose after server changes.

The commands below assume mise is active in your shell. Otherwise prefix each
pnpm command with `mise exec --`.

```sh
pnpm check                          # Biome and TypeScript
pnpm test                           # Vitest
pnpm build                          # Production web assets
pnpm exec playwright install chromium
pnpm test:browser                   # Same-origin UI/API smoke test
pnpm db:migrate                     # Reapply pending app and queue migrations
pnpm db:seed                        # Upsert one synthetic record and test object
pnpm smoke                          # Check private storage, checksum, and worker
```

Use `STUDIO_BASE_URL` to point the browser test at the hot-reload server or a
custom app port. Use `pnpm db:generate` after changing the Drizzle schema and
review the generated SQL before applying it.

To verify persistence, run `docker compose down` followed by
`docker compose up -d --wait`. Run `pnpm smoke fixture` before reseeding. It
compares the stored bytes with the checksum in PostgreSQL and checks anonymous
read, write, and list denial. `pnpm smoke worker` validates a completed pg-boss
job and prints the request ID for matching the app and worker logs.

`docker compose logs app worker migrate storage` shows service diagnostics.
`docker compose down` stops the stack and retains both named volumes.

## Local staff access

Run `pnpm local:init` and rebuild the Compose stack when upgrading from Slice 1.
The initializer adds missing staff settings to the existing `.env` while
keeping the credentials for both named volumes.

Open [Staff sign in](http://127.0.0.1:3000/sign-in). Register
`director@studio.test`, then open [Mailpit](http://127.0.0.1:8025), follow
the verification link, choose **Verify email**, and sign in. Register and verify a second synthetic
`@studio.test` account to test grants from **Manage staff access**.
`STUDIO_STAFF_DOMAINS` and `STUDIO_DIRECTOR_EMAIL` configure the approved
addresses. The first director claim stays with the database after it is made.

If this checkout has local test accounts, open
[the local credentials file](.local/staff-test-accounts.md) for the L1 Panelist,
L2 Panelist, HR, and Director logins. Git ignores this file.

For the full browser test, use a fresh Compose project so the director can
register at the start of the test.

```sh
export STUDIO_PORT=13000 STUDIO_MAILPIT_PORT=18025 STUDIO_AUTH_ORIGIN=http://127.0.0.1:13000
export STUDIO_STAFF_DOMAINS=studio.test STUDIO_DIRECTOR_EMAIL=director@studio.test
docker compose -p studio-staff-test up -d --build --wait
STUDIO_BASE_URL=http://127.0.0.1:13000 STUDIO_TEST_MAILPIT_URL=http://127.0.0.1:18025 pnpm test:browser
docker compose -p studio-staff-test down --volumes
unset STUDIO_PORT STUDIO_MAILPIT_PORT STUDIO_AUTH_ORIGIN STUDIO_STAFF_DOMAINS STUDIO_DIRECTOR_EMAIL
```

Set `STUDIO_TEST_DATABASE_URL` to a fresh test PostgreSQL database to include
the transactional role and interview tests in `pnpm test`. The role tests migrate
and insert synthetic rows in that database. The interview tests use the same
server with a temporary database to verify upgrades from earlier slices, so the
test role needs permission to create databases.

## Local drive intake

Rebuild the local stack with `docker compose up -d --build --wait`. An HR
account can open [Drives](http://127.0.0.1:3000/staff/drives), create a drive,
and upload a job description and resumes. The [synthetic intake fixtures](tests/fixtures/intake/)
include text PDF and DOCX files, an [image-only resume](tests/fixtures/intake/ocr-resume.pdf),
an unreadable scan, and a DOCX that exceeds the extraction limit.

Resume intake accepts PDF, DOCX, PNG, and JPEG. Open a candidate and choose
**View resume** to open it next to the candidate form on desktop. On smaller
screens, switch between the resume and candidate details while keeping your
draft. PDFs and scans support zoom and scrolling. The DOCX preview shows headings, lists,
tables, and embedded images. Use **Download original** for exact Word formatting.

The worker reads selectable resume text first. When candidate details are missing
or ambiguous, it can run Tesseract locally on a PNG or JPEG resume, up to three
PDF pages, or embedded PNG or JPEG images in a DOCX body. The worker image includes
the English recognition model. Review the suggested values against the original
before confirming the candidate. Experience ranges, approximations, and conflicting
totals are left for HR to enter.

To seed a sample drive, substitute the address of a verified synthetic HR account.

```sh
docker compose exec -e STUDIO_SEED_DRIVE_HR=hr-fixture@studio.test app node apps/server/src/seed.ts
```

Run the browser suite against a fresh `studio-*-test` Compose project. To include
the recovery drills, also set `STUDIO_TEST_COMPOSE_PROJECT` to that project's
name. The drills temporarily stop its worker and storage and inject failures
into its test database.

## Local interview rehearsal

Run `pnpm local:init` to add the dedicated `STUDIO_INTERVIEW_SECRET` to an
existing local environment before rebuilding. Keep the key with the local stack.
After rotating it, replace the Studio link on each scheduled round and update
its Teams invitation. Existing invitation secrets cannot be used with the new key.

Use a fresh Compose project and a synthetic password. The seed creates two
verified panelists with the same display name, an HR account, confirmed candidates
in two drives, reviewed skills for both rounds, and an overlapping booking.
Running the seed twice preserves the existing fixture records and round.

```sh
export STUDIO_PORT=13004 STUDIO_MAILPIT_PORT=18024
export STUDIO_AUTH_ORIGIN=http://127.0.0.1:13004 STUDIO_AUTH_ALLOW_LOOPBACK=true
export STUDIO_STAFF_DOMAINS=studio.test STUDIO_DIRECTOR_EMAIL=director@studio.test
export STUDIO_SEED_INTERVIEW_PASSWORD='A-local-synthetic-password'
docker compose -p studio-interviews-test up -d --build --wait
docker compose -p studio-interviews-test exec -e STUDIO_SEED_INTERVIEW_PASSWORD app node apps/server/src/seed.ts

STUDIO_TEST_INTERVIEW_PASSWORD="$STUDIO_SEED_INTERVIEW_PASSWORD" \
STUDIO_BASE_URL=http://127.0.0.1:13004 \
STUDIO_TEST_MAILPIT_URL=http://127.0.0.1:18024 \
pnpm test:browser --workers=1
```

Open **Interviews** as `slice4-hr@studio.test`. The panelist accounts are
`slice4-panelist@studio.test` and `slice4-other@studio.test`. Use the synthetic
password for all three. The browser suite uploads and confirms a new resume,
books both rounds, and admits the candidate with separate Mailpit codes. It
checks draft save and reload, L1 feedback submission, the L2 handoff and decision,
and HR review after an L1 correction. Set `STUDIO_TEST_INTERVIEW_SCREENSHOTS=1`
to capture the mobile draft and L2 handoff, desktop submitted scorecard, and
both HR review layouts under `test-results`.

For a shared-host rehearsal, use the configured HTTPS Studio origin and verify
that both participants can open the full link, including the fragment, from
an actual Teams invitation. Candidate request limits use the direct socket peer
by default. If an ingress proxies all requests, set
`STUDIO_INTERVIEW_TRUSTED_PROXIES` to its exact app-facing IP addresses,
comma separated. Restrict the app listener to that ingress and configure the
ingress to overwrite `X-Studio-Client-IP` with a single verified client address
on every request.

## Web design system

Tailwind CSS v4 runs through the Vite plugin in `apps/web`. Its CSS-first
configuration and the supplied PwC-inspired light and dark tokens live in
`apps/web/src/globals.css`. Light is the default. The status page switches themes
by setting the `.dark` class on the root element, so portaled overlays inherit it.

`apps/web/components.json` configures shadcn Base Nova with Base UI primitives,
Neutral as the registry base, Lucide icons, and solid menus with a subtle accent.
Generated components live in `apps/web/src/components/ui`. Status badges have
`success`, `warning`, `info`, `error`, and `muted` variants.

Use the pinned CLI from the web workspace:

```sh
pnpm --filter @studio/web ui add <component>
pnpm --filter @studio/web ui add <component> --diff
```

Review registry updates before replacing files with local interaction or theme
changes.

See the [implementation roadmap](docs/core/requirements-roadmap.md) for the remaining
Slice 1 deployment checks and the staff access slice.
