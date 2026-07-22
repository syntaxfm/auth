# Syntax Auth

Standalone SvelteKit auth and OAuth 2.1/OIDC provider for Syntax, deployed as a Cloudflare Worker.
Production `*.syntax.fm` applications share the one central Better Auth session from this service;
they do not create per-app auth or session tables. This service is **auth-only and D1-only**. Its
dedicated D1 database is named `syntax-auth`.

**Integrating an app? Read [`CONSUMING_AUTH.md`](./CONSUMING_AUTH.md).** It defines the central
first-party session contract, trust boundary, safe login return flow, central logout, and the OIDC
fallback for localhost or external domains.

This project does not connect to, migrate, or modify the Syntax website or the website's
PostgreSQL database. No existing website, legacy auth, or SynHax users are migrated. A person gets
a new auth identity in D1 on their first GitHub sign-in.

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

Do not run these migrations from the website project and do not point this Worker at the website's
PostgreSQL database.

## Local development

1. Copy `.dev.vars.example` to `.dev.vars` and replace every example value with local,
   non-production values. `.dev.vars` is ignored; never commit it.
2. Apply the migration to Wrangler's local D1 state and start SvelteKit:

   ```sh
   pnpm d1:migrate:local
   pnpm dev
   ```

The Cloudflare adapter supplies `event.platform.env`, including the local `DB` binding and the
variables from `.dev.vars`. Local D1 data is stored under the ignored `.wrangler/` directory.
Leave `AUTH_COOKIE_DOMAIN` unset locally: localhost uses a host-only cookie and cannot reproduce
cross-subdomain sharing. Use a controlled HTTPS Syntax development subdomain/tunnel for identical
behavior, or use the OIDC fallback documented in `CONSUMING_AUTH.md`.

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
OAuth client. Registration is only for plain localhost or consumers outside `syntax.fm` that use
the OIDC fallback.

Dynamic and unauthenticated client registration remain disabled. The registration command loads
the D1 binding through Wrangler's supported platform proxy and calls Better Auth's server-only
`auth.api.adminCreateOAuthClient` API directly. It creates a one-use Better Auth session to satisfy
the API's authenticated-client-creation requirement, detaches the new client, and deletes the
temporary user, account, and session in the same command. It does not add an HTTP admin endpoint.

Register against local D1 after applying the local migration:

```sh
pnpm oauth:register \
  --name "Syntax Website" \
  --redirect-uri "http://localhost:5173/auth/callback" \
  --post-logout-redirect-uri "http://localhost:5173" \
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
environment marks only the D1 binding as remote; local values from `.dev.vars` initialize Better
Auth without exposing production Worker secrets to the Node script. Better Auth performs the client
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

`GET /api/health` returns `{ "status": "ok" }` without opening D1 or requiring auth secrets.

After deployment, verify health and discovery before updating any consumer to use the new issuer:

```sh
curl --fail https://auth.syntax.fm/api/health
curl --fail https://auth.syntax.fm/api/auth/.well-known/openid-configuration
```
