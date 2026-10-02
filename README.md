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
secrets: the Cloudflare adapter reads the committed `local` Wrangler environment, which has a
loopback URL, no shared cookie domain, and a local-only D1 database under the ignored `.wrangler/`
directory. In that mode Syntax Auth replaces GitHub with a one-click local developer account (user
ID `local-developer`) and answers only `localhost` and `auth.syntax.test`, the local HTTPS name
that apps on `https://syntax.test` and `https://*.syntax.test` send browsers to. On
`auth.syntax.test`, and on app servers' `localhost` calls that forward its cookie, sessions use the
shared `.syntax.test` cookie described in `CONSUMING_AUTH.md`. Under `vite dev` (`pnpm dev`) and
`vite preview` (the Docker image), a plugin in `vite.config.ts` answers every request for any other
host, including `/api/health` and built files, with a plain-text 403 naming the host and the two
addresses to use, before Vite's own host check or file serving. `src/hooks.server.ts` refuses
other hosts the same way for every page and auth route, so `wrangler dev` (`pnpm preview`), which
skips the Vite plugin, still refuses them there; it serves `/api/health` and built files to any
host. In local mode, a request from an origin local Syntax Auth doesn't trust gets Better Auth's
403 `INVALID_ORIGIN` with a message naming the origin and the origins it accepts.
Deploys use the top-level configuration and never enable local mode.

Consumer apps run the same service from the private `ghcr.io/syntaxfm/auth-local` Docker image,
which `.github/workflows/local-image.yml` publishes from `main`. The image serves a production
build with `vite preview`, which watches no files; local mode turns off Better Auth's rate
limiting, as dev builds always have. The `packages/auth-local` Vite plugin starts it and, for
syntaxfm members, pulls it with their GitHub CLI login without storing the token; see
`CONSUMING_AUTH.md`. The port lives in `packages/auth-local/container.js`,
`vite.config.ts`, and the `local` and `oauth-registration` envs in `wrangler.jsonc`.

### https://auth.syntax.test

On macOS, `pnpm dev` also makes `https://auth.syntax.test` answer, through the same plugin
(`syntax_auth({ name: 'auth' })` in `vite.config.ts`), as every Syntax app's dev server does for
its own name. `CONSUMING_AUTH.md` describes each step; the first start asks for your password once
(for `/etc/hosts`) and one approval (to trust Caddy's local root), and later starts ask nothing.
Syntax Auth's own dev server never redirects `localhost`, because apps call it there.

Setup never shows a dialog from an AI coding agent's shell (`CLAUDECODE` or `PI_CODING_AGENT`
set), over SSH (`SSH_CONNECTION` or `SSH_TTY`), in CI (`CI`), under a test runner
(`NODE_TEST_CONTEXT` or `VITEST`), or outside the Mac's desktop session. It then changes nothing,
says why on its first line, and prints each fix, such as running
`node packages/auth-local/bin.js setup auth` in Terminal at the Mac's own screen. To let an
agent's run show the dialogs while you watch the screen, start it with
`SYNTAX_DEV_SETUP_DIALOGS=allow` (for example `SYNTAX_DEV_SETUP_DIALOGS=allow pnpm dev`); the
switch never works over SSH, in CI, or under a test runner.

Setup leaves everything in place when dev stops. To undo it:

```sh
# The routes and certificate policy, from whichever Caddy got them:
for id in syntax-test-auth syntax-test-lab syntax-test-website syntax-test-tls; do
	curl -X DELETE "localhost:2019/id/$id"
done
# Syntax's own Caddy container, if setup started one, and its certificates:
docker rm --force syntax-caddy && docker volume rm syntax-caddy-data syntax-caddy-config
# Trust in Caddy's root (find its SHA-1 with the first command):
security find-certificate -a -Z -c "Caddy Local Authority" ~/Library/Keychains/login.keychain-db
security delete-certificate -Z <sha1> ~/Library/Keychains/login.keychain-db
# The hosts block (/etc/hosts.syntax-test.bak holds the file from before the last change):
sudo sed -i '' '/^# >>> syntax.test: added by Syntax dev setup/,/^# <<< syntax.test$/d' /etc/hosts
```

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
`vite preview` on a free port with a temporary D1, and signs in on `localhost` and
`auth.syntax.test`, and the `packages/auth-local` tests (also `pnpm --dir packages/auth-local
test`). Those run setup against stand-ins for Caddy, docker, the password dialog (the real hosts
script edits a temporary file), and macOS's `security`. None of them touches port 37960, the
container, `.wrangler/state`, `/etc/hosts`, the keychain, or ports 80, 443, and 2019. Under a test
runner, setup shows no dialog, and the package refuses to run `osascript`, `sudo`, `open`,
`docker`, or a `security` command that changes the keychain, so a test that misses a stand-in
fails instead of acting on your Mac.

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
