# Interview Studio

## Start on macOS

Use mise and a running Docker Compose environment. With Colima, confirm
`docker context show` reports `colima` before starting.

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

See the [implementation roadmap](docs/requirements-roadmap.md) for the remaining
Slice 1 deployment checks and the staff access slice.
