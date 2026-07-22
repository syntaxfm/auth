# Consuming Syntax Auth

Use this guide when adding Syntax authentication to any application. It is written to be handed
directly to a coding agent.

## Provider contract

- Provider: `https://auth.syntax.fm`
- Issuer: `https://auth.syntax.fm/api/auth`
- Discovery: `https://auth.syntax.fm/api/auth/.well-known/openid-configuration`
- Authorization flow: OAuth 2.1 Authorization Code with PKCE (`S256`)
- Supported identity scopes: `openid profile email`
- Optional persistent-access scope: `offline_access`
- Signing algorithm: EdDSA using the provider's published JWKS

Always discover endpoints from the issuer metadata instead of hard-coding authorization, token,
UserInfo, logout, or JWKS URLs.

## Agent instructions

```text
Integrate this application with the central Syntax OpenID Connect provider.

Issuer: https://auth.syntax.fm/api/auth
Discovery: https://auth.syntax.fm/api/auth/.well-known/openid-configuration

Requirements:
- Use a maintained OAuth 2.1/OpenID Connect client library appropriate for this application's
  framework. Do not implement OAuth or token verification manually.
- Use Authorization Code with PKCE S256, state, and OIDC nonce.
- Validate the ID token signature, issuer, audience, expiration, and nonce.
- Treat the OIDC `sub` claim as the canonical, immutable Syntax identity. Never use email,
  username, or display name as an identity key.
- Store the client secret only in server-side environment variables. Never expose it to browser
  code, public environment variables, logs, or source control.
- For a server-rendered application, exchange the authorization code on the server and create an
  application-owned, host-only, HttpOnly, Secure session cookie.
- Do not share a `.syntax.fm` cookie, read the auth service's D1 database, or use an auth access
  token as the application's browser session cookie.
- Keep application roles and permissions in this application's datastore. Authentication proves
  identity; it does not automatically grant access.
- Request only `openid profile email` unless the application genuinely needs refresh tokens. Add
  `offline_access` only when persistent delegated access is required, and store refresh tokens
  encrypted at rest.
- Implement local logout by deleting the application's local session. When global logout is
  required, use the provider's discovered end-session endpoint and then clear the local session.
- Fail closed when token validation, state validation, nonce validation, or code exchange fails.
- Add deterministic tests for callback validation, session creation, unauthorized requests, and
  logout.

Expected private environment variables:
AUTH_ISSUER=https://auth.syntax.fm/api/auth
AUTH_CLIENT_ID=<registered client id>
AUTH_CLIENT_SECRET=<registered confidential client secret>
AUTH_REDIRECT_URI=<exact registered callback URL>
```

Before implementing, inspect the application's existing auth/session conventions and use its
established library when that library has standards-compliant OIDC support.

## Client registration

Every application and environment must be registered before it can redirect users back from the
provider. Redirect URIs are exact allowlist entries: scheme, hostname, port, and path must match.

Use separate clients for production and development. This keeps production credentials out of
local environments and allows either client to be revoked independently.

Register a production server-rendered application from this repository:

```sh
pnpm oauth:register \
  --remote \
  --name "Example App (Production)" \
  --redirect-uri "https://example.syntax.fm/auth/callback" \
  --post-logout-redirect-uri "https://example.syntax.fm" \
  --scope "openid profile email" \
  --skip-consent \
  --enable-end-session
```

Register its local development client against the same production auth server:

```sh
pnpm oauth:register \
  --remote \
  --name "Example App (Local Development)" \
  --redirect-uri "http://localhost:5173/auth/callback" \
  --post-logout-redirect-uri "http://localhost:5173" \
  --scope "openid profile email" \
  --skip-consent \
  --enable-end-session
```

The command prints a confidential client secret once. Put it directly into the consuming
application's secret manager. Do not paste it into issues, chat, logs, or source files.

Use `--public` only for applications that cannot safely hold a client secret, such as a browser-only
SPA or native application. Public clients must still use PKCE.

## Localhost behavior

Local applications can use `auth.syntax.fm`. OAuth permits plain HTTP for loopback development
redirects. The following rules apply:

- Register the exact localhost callback, including its port and path.
- `localhost` and `127.0.0.1` are different redirect hosts and require separate entries.
- A different development port requires another registered URI or client.
- Use the same browser for the local application and `auth.syntax.fm` to receive SSO from the
  existing central session.
- The browser will briefly navigate through `auth.syntax.fm` and return to localhost. This is
  expected and does not require CORS.
- Token exchange for a confidential client happens from the local application's server, not from
  browser JavaScript.

The auth server's cookie remains host-only to `auth.syntax.fm`. A local application receives its own
local session cookie after the OIDC callback.

## Identity and authorization

Persist the OIDC `sub` claim as the cross-property identity reference. A typical application record
uses a shape such as:

```text
application_user
- id
- auth_user_id  // OIDC sub, unique
- application-specific profile fields
```

Do not copy authentication secrets, provider accounts, or central session records into consumer
databases. Store only the identity reference and application-owned data.

Applications decide their own authorization rules. Signing into Syntax Auth does not imply admin,
staff, paid, or content-editing access.

## Session expectations

After the callback succeeds, the application should create its own opaque session with:

- A cryptographically random token
- A server-side expiration
- Rotation after authentication and privilege changes
- An HttpOnly, Secure, host-only cookie
- `SameSite=Lax` unless the application's documented flow requires something else
- Server-side revocation on logout

Short-lived ID and access tokens are evidence used during the OIDC flow, not replacements for a
well-scoped application session.

## Acceptance checks

Before considering an integration complete, verify:

1. A signed-out visitor is redirected to `auth.syntax.fm` and can sign in with GitHub.
2. A visitor already signed into `auth.syntax.fm` returns without another GitHub prompt.
3. Invalid state, nonce, issuer, audience, signature, and expired-token cases fail closed.
4. The authorization code cannot be reused.
5. The resulting local session survives navigation and is unavailable to browser JavaScript.
6. Local logout revokes the local session.
7. Global logout uses the discovered end-session endpoint when enabled.
8. Unauthorized users remain blocked even when they are correctly authenticated.
9. Both the production callback and the separately registered localhost callback work.
