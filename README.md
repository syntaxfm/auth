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
D1, and serves `http://localhost:37960`. It needs no secrets: the Cloudflare adapter reads the
committed `local` Wrangler environment, which has a loopback URL, no shared cookie domain, and a
local-only D1 database under the ignored `.wrangler/` directory. In that mode Syntax Auth replaces
GitHub with a one-click local developer account (user ID `local-developer`), trusts only
`localhost` origins, and refuses requests for any other host. Deploys use the top-level
configuration and never enable local mode.

Consumer apps run the same service from the private `ghcr.io/syntaxfm/auth-local` Docker image,
which `.github/workflows/local-image.yml` publishes from `main`. The `packages/auth-local` Vite
plugin starts it and, for syntaxfm members, pulls it with their GitHub CLI login without storing
the token; see `CONSUMING_AUTH.md`. The port lives in `packages/auth-local/container.js`,
`vite.config.ts`, and the `local` and `oauth-registration` envs in `wrangler.jsonc`.

Useful commands:

```sh
pnpm check
pnpm lint
pnpm build
pnpm preview
pnpm cf-typegen
pnpm db:generate
pnpm d1:migration:create <migration-name>
```

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
