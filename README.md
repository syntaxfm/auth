# Syntax Auth

Standalone SvelteKit auth and OAuth 2.1/OIDC provider for Syntax, deployed as a Cloudflare Worker.
Production `*.syntax.fm` applications share the one central Better Auth session from this service;
they do not create per-app auth or session tables. This service is **auth-only and D1-only**. Its
dedicated D1 database is named `syntax-auth`.

**Integrating an app? Read [`CONSUMING_AUTH.md`](./CONSUMING_AUTH.md).** It defines the central
first-party session contract, trust boundary, safe login return flow, central logout, local
development against a local Syntax Auth, and the OIDC flow for external domains.

## Consumer agent prompts

Paste one of these into an agent session in the app being integrated. `CONSUMING_AUTH.md` holds
every detail, so the prompts only say which case applies.

For an app on `syntax.fm` or a `*.syntax.fm` subdomain:

```text
Integrate this app with Syntax Auth by following
https://github.com/syntaxfm/auth/blob/main/CONSUMING_AUTH.md exactly, including its Local
development section and Acceptance checks. This app runs on syntax.fm or a *.syntax.fm subdomain,
so use the shared session. Keep this app's existing conventions.
```

For an app on any other domain:

```text
Integrate this app with Syntax Auth by following
https://github.com/syntaxfm/auth/blob/main/CONSUMING_AUTH.md exactly, including its Acceptance
checks. This app runs outside syntax.fm, so use the External domains (OpenID Connect) flow. Keep
this app's existing conventions.
```

Cross-project Auth and development setup work is tracked in Lab's Dex. This repository does not
have a second task store for the same work; app-specific task histories stay with their apps.

## What D1 stores

The initial migration creates only the Better Auth and OAuth provider tables:

- `user`, `account`, `session`, and `verification`
- `jwks`
- `oauth_client`, `oauth_access_token`, `oauth_refresh_token`, and `oauth_consent`

OAuth array and metadata fields are JSON-encoded SQLite `text` columns. Dates are integer
millisecond timestamps and booleans are SQLite integers, matching Better Auth 1.6.23's generated
SQLite schema.

## Cloudflare setup

The `syntax-auth` D1 database is provisioned in the Syntax Cloudflare account and bound in
`wrangler.jsonc`.

1. Install Node 22 and pnpm, then authenticate Wrangler:

   ```sh
   pnpm install
   pnpm exec wrangler login
   ```

2. `BETTER_AUTH_URL`, `AUTH_COOKIE_DOMAIN`, and `GITHUB_CLIENT_ID` are committed as non-secret
   Worker variables in `wrangler.jsonc`. Production sets `AUTH_COOKIE_DOMAIN=.syntax.fm` so trusted
   first-party subdomains receive the central session cookie. Store only the private values as
   Worker secrets and generate `BETTER_AUTH_SECRET` with `openssl rand -base64 32`.

   ```sh
   pnpm exec wrangler secret put BETTER_AUTH_SECRET
   pnpm exec wrangler secret put GITHUB_CLIENT_SECRET
   ```

3. Apply the migration to the dedicated remote D1 database, then deploy:

   ```sh
   pnpm d1:migrate:remote
   pnpm deploy
   ```

4. In the Cloudflare dashboard, open the `syntax-auth` Worker, add the custom domain
   `auth.syntax.fm`, and verify its DNS and certificate are active.

5. Configure the GitHub OAuth App callback URL:

   ```text
   https://auth.syntax.fm/api/auth/callback/github
   ```

## Local development

```sh
pnpm install
pnpm dev
```

`pnpm dev` stops the shared `syntax-auth` container if one is running, applies migrations to local
D1, and serves `http://localhost:37960`. `pnpm preview` does the same with a production build.
Both run through `scripts/local_server.js`: however they stop, they stop every process they
started and start the container again, so other Syntax apps keep signing in. Neither needs
secrets, and neither changes anything else on the machine: the Cloudflare adapter reads the
committed `local` Wrangler environment, which has a loopback URL, no shared cookie domain, and a
local-only D1 database under the ignored `.wrangler/` directory. In that mode Syntax Auth replaces
GitHub with a one-click local developer account (user ID `local-developer`) and answers only
`localhost`, `127.0.0.1`, and `[::1]`. Under `vite dev` (`pnpm dev`) and `vite preview` (the Docker
image), a plugin in `vite.config.ts` answers every request for any other host, including
`/api/health` and built files, with a plain-text 403 naming the host and the address to use,
before Vite's own host check or file serving. `src/hooks.server.ts` refuses other hosts the same
way for every page and auth route, so `wrangler dev` (`pnpm preview`), which skips the Vite
plugin, still refuses them there; it serves `/api/health` and built files to any host. In local
mode, a request from an origin local Syntax Auth doesn't trust gets Better Auth's 403
`INVALID_ORIGIN` with a message naming the origin and the origins it accepts. Deploys use the
top-level configuration and never enable local mode.

Browsers on other addresses (a LAN or VPN address, or a developer's own HTTPS name) never reach
this server: they sign in through their app's development proxy from `packages/auth-local`, which
calls it on loopback, and sign out through that proxy or through their app's own sign-out
endpoint, whose server calls it on loopback with the browser origin it validated (see
`CONSUMING_AUTH.md`, "Local development"). Per request, `src/hooks.server.ts` picks host-only
cookies, `__Secure-` ones for a browser on https, from the session cookie's name or from a checked
`x-syntax-auth-dev-origin` header sent by the proxy or an app server
(`src/lib/server/dev_proxy.ts`); when `Origin` is present it must equal that header. A loopback
caller may omit `Origin`, but consumer sign-out servers send both after validating the browser
origin. The service then trusts that one origin for the request. It serves local `/api/auth/*` calls before its own session
lookup, so a refreshed cookie always reaches the app server that asked. A local sign-out ends the
session of each session cookie the request carries, plain and `__Secure-`, and a sign-in on http
expires a `__Secure-` one that would be read before it (`src/lib/server/local_session_cookies.ts`).

Consumer apps run the same service from the private `ghcr.io/syntaxfm/auth-local` Docker image,
which `.github/workflows/local-image.yml` publishes from `main`. The image serves a production
build with `vite preview`, which watches no files; local mode turns off Better Auth's rate
limiting, as dev builds always have. The `packages/auth-local` Vite plugin starts it and, for
syntaxfm members, pulls it with their GitHub CLI login without storing the token; see
`CONSUMING_AUTH.md`. The port lives in `packages/auth-local/container.js`,
`vite.config.ts`, and the `local` and `oauth-registration` envs in `wrangler.jsonc`.

No dev server and no `syntax-auth-local` opens Docker Desktop or OrbStack, whose first run and
privileged helper can show dialogs, from an AI coding agent's shell (`CLAUDECODE` or
`PI_CODING_AGENT` set), over SSH (`SSH_CONNECTION` or `SSH_TTY`), in CI (`CI`), under a test runner
(`NODE_TEST_CONTEXT` or `VITEST`), or outside the Mac's desktop session; if Docker isn't running,
the app runs signed out and says to start Docker, then restart dev. Each of those variables counts
when set at all, even to an empty string, `0`, or `false`. When Docker already runs, the local
Syntax Auth container still starts. `SYNTAX_DEV_SETUP_DIALOGS=allow` at the Mac's screen lets an
agent's run open Docker too; it never works over SSH, in CI, or under a test runner.

### The superseded `.syntax.test` setup

Earlier versions of the plugin set up `https://*.syntax.test` names on macOS. The per-app
development proxy supersedes that architecture: nothing sets it up or relies on it any more, and
nothing removes what it added. Current apps do not need those resources; existing routes, trust,
and hosts entries may still affect other projects. If you remove them, do so deliberately, one
piece at a time, after checking that the piece belongs to that setup and not to
something else on the machine:

- **Caddy routes.** The setup added routes with the IDs `syntax-test-auth`, `syntax-test-lab`,
  `syntax-test-website`, and `syntax-test-tls` to whichever Caddy was running, possibly one shared
  with other projects. Inspect its configuration through Caddy's admin API first, and remove only
  those IDs; never replace or delete the whole configuration.
- **A `syntax-caddy` container** with `syntax-caddy-data` and `syntax-caddy-config` volumes, if the
  setup started one. Confirm with `docker inspect` that it is that container before removing it.
  The data volume holds Caddy's local certificate authority and certificates; back it up first if
  anything else may have used it.
- **Trust in Caddy's local root certificate.** Other Caddy installs use the same "Caddy Local
  Authority" name, so match the trusted certificate's fingerprint against the root in the Caddy
  data you are removing, and remove that trust only when no Caddy you still use relies on it.
- **The hosts-file block.** Back up `/etc/hosts` first, then remove only the lines from
  `# >>> syntax.test: added by Syntax dev setup` through `# <<< syntax.test`, and keep everything
  else.

Useful commands:

```sh
pnpm check
pnpm lint
pnpm test
pnpm build
pnpm preview
pnpm cf-typegen
pnpm db:generate
pnpm d1:migration:create <migration-name>
```

`pnpm test` runs the unit tests, an integration test that builds the app, serves it with
`vite preview` on a free port with a temporary D1, and signs in on `localhost` and, through the
real development proxy from `packages/auth-local` in front of it, as a browser on a LAN address
and on an https name, and the `packages/auth-local` tests (also `pnpm --dir packages/auth-local
test`). Those run the proxy against stand-ins for local Syntax Auth, routed servers, and broken
upstreams on free loopback ports, and the container start against a stand-in `docker`. None of
them touches port 37960, the container, or `.wrangler/state`. Under a test runner the package
refuses to run `osascript`, `sudo`, `open`, `docker`, or a `security` command that changes the
keychain, so a test that misses a stand-in fails instead of acting on your machine.

`drizzle.config.ts` is intentionally generation-only: it declares the SQLite schema and migrations
directory without inventing a local SQLite URL or storing Cloudflare credentials. Apply migrations
with Wrangler's `d1:migrate:local` and `d1:migrate:remote` commands.

## Register an OAuth client for fallback consumers

Production first-party `*.syntax.fm` applications use the shared central session and do not need an
OAuth client, including during local development. Registration is only for consumers outside
`syntax.fm` that use the OIDC flow.

Dynamic and unauthenticated client registration remain disabled. The registration command loads
the D1 binding through Wrangler's supported platform proxy and calls Better Auth's server-only
`auth.api.adminCreateOAuthClient` API directly. It creates a one-use Better Auth session to satisfy
the API's authenticated-client-creation requirement, detaches the new client, and deletes the
temporary user, account, and session in the same command. It does not add an HTTP admin endpoint.

Register against local D1 (after `pnpm dev` has applied the local migration):

```sh
pnpm oauth:register \
  --name "External App (local)" \
  --redirect-uri "http://localhost:3000/auth/callback" \
  --post-logout-redirect-uri "http://localhost:3000" \
  --skip-consent \
  --enable-end-session
```

Register against remote D1 after applying the remote migration:

```sh
pnpm oauth:register \
  --remote \
  --name "External App" \
  --redirect-uri "https://example.com/auth/callback" \
  --post-logout-redirect-uri "https://example.com" \
  --skip-consent \
  --enable-end-session
```

Remote registration requires Wrangler authentication. The dedicated `oauth-registration` Wrangler
environment marks only the D1 binding as remote and initializes Better Auth in local mode, without
exposing production Worker secrets to the Node script. Better Auth performs the client
secret hashing and storage. The generated client secret is printed once, so store it immediately in
the client application's secret manager. Omit `--skip-consent` unless the client is trusted. Add
`--public` for a client that cannot hold a secret; PKCE is required for every registered client.

## OIDC and health

The issuer is `${BETTER_AUTH_URL}/api/auth`. The provider retains GitHub login, JWT/JWKS signing,
the `openid profile email offline_access` scopes, `/sign-in`, `/consent`, and Better Auth's default
PKCE protections.

Discovery metadata is available at:

- `/api/auth/.well-known/openid-configuration`
- `/api/auth/.well-known/oauth-authorization-server`
- `/.well-known/oauth-authorization-server/api/auth`

`GET /api/health` returns `{ "status": "ok", "service": "syntax-auth" }` without opening D1 or requiring auth secrets.

After deployment, verify health and discovery before updating any consumer to use the new issuer:

```sh
curl --fail https://auth.syntax.fm/api/health
curl --fail https://auth.syntax.fm/api/auth/.well-known/openid-configuration
```
