# Consuming Syntax Auth

Production applications on trusted `*.syntax.fm` subdomains share one central Better Auth session
owned by `https://auth.syntax.fm`. They do not run a second authentication system.

## First-party `*.syntax.fm` integration

A production Syntax app must not create its own auth, user, account, or session tables. It also must
not add an OAuth client, OAuth callback handler, or app-specific auth cookie. The browser sends the
central HttpOnly bearer cookie to every `*.syntax.fm` host, and each app asks Syntax Auth to validate
it. Better Auth 1.6.23 keeps the cookie `Secure`, `HttpOnly`, and `SameSite=Lax` while setting its
production domain to `.syntax.fm`.

In server middleware or a server hook, for every request that needs authentication:

1. Read the incoming `Cookie` header without parsing or changing it.
2. Make a server-to-server request to `https://auth.syntax.fm/api/auth/get-session` with that exact
   `Cookie` header.
3. Disable caching with the runtime's `cache: 'no-store'` option and a `Cache-Control: no-store`
   request header. Never cache the response in a CDN, shared cache, or process-global variable.
4. Treat a `null`, malformed, or unsuccessful response as signed out.
5. Copy only the allowed fields below into the framework's per-request context (`locals`, request
   state, or its equivalent).
6. If Syntax Auth refreshes cookies in a `Set-Cookie` response, append every header to the browser
   response unchanged. Preserve separate `Set-Cookie` headers; never comma-join or split them.

The default user fields are:

- `id`: the canonical immutable Syntax identity, equivalent to OIDC `sub`
- `name`
- `email`
- `emailVerified`
- `image`
- `createdAt`
- `updatedAt`

The sanitized session context may contain `id`, `userId`, `expiresAt`, `createdAt`, and `updatedAt`.
Better Auth also returns the session `token` and may return request metadata such as `ipAddress` and
`userAgent`; omit those unless server-only application logic genuinely requires the metadata.
Never put the session token in page data, serialized state, browser JavaScript, logs, analytics, or
a consumer API response.

Authentication and session validity remain central. Authorization remains app-owned: each app
decides whether that user is an admin, subscriber, editor, or otherwise allowed to perform an
action. Store application roles and data against the central user `id`; do not copy central session
records or provider accounts.

## Sign in and return

Send a signed-out browser to the central sign-in page with its current absolute URL:

```text
https://auth.syntax.fm/sign-in?return_to=<encoded current app URL>
```

Build the query with a URL API rather than string concatenation. Syntax Auth accepts only
`https://syntax.fm` and HTTPS hosts ending exactly in `.syntax.fm`; it rejects credentials,
non-HTTPS production URLs, external hosts, and deceptive suffixes. An existing valid central
session returns immediately to the app. Otherwise the same validated URL is used after GitHub sign
in.

The app must still validate authorization after the user returns. `return_to` proves neither
identity nor access.

## Central logout

Logout must invalidate the central session and clear the shared cookie. Use one of these flows:

- Send the browser to the existing signed-in surface at `https://auth.syntax.fm/`, where it can sign
  out centrally.
- Add a POST action in the consuming app that forwards the incoming `Cookie` and trusted app
  `Origin` to `POST https://auth.syntax.fm/api/auth/sign-out`, then forwards every returned
  `Set-Cookie` header to the browser unchanged.

Do not invent a GET logout URL: this service does not implement one, and logout must not be a GET
side effect. A proxy must preserve multiple `Set-Cookie` values with the runtime's native API and
must never expose the token while forwarding them.

## Trust boundary

The shared cookie is a bearer credential. Every `*.syntax.fm` server receives it, so every server
under that parent domain is inside the authentication trust boundary. Only trusted first-party
applications may use Syntax subdomains. Do not host prototypes, user content, customer apps,
unreviewed previews, or other untrusted services anywhere under `syntax.fm`.

Compromise of one trusted subdomain can expose the cookie presented to that server. Keep each app
patched, prevent request/header logging from recording cookies, and remove abandoned subdomains.

## Localhost and external domains

`localhost` cannot receive a `.syntax.fm` cookie. For behavior identical to production, use a
controlled HTTPS development subdomain or tunnel under `syntax.fm`; because it receives the real
bearer cookie, it must meet the same first-party trust requirements.

For plain localhost or an app outside `syntax.fm`, use this service's OIDC provider as the fallback:

- Issuer: `https://auth.syntax.fm/api/auth`
- Discovery: `https://auth.syntax.fm/api/auth/.well-known/openid-configuration`
- Flow: Authorization Code with PKCE (`S256`), state, and nonce
- Identity scopes: `openid profile email`

Use a maintained OIDC client and discover endpoints from metadata. This fallback does not require
a local user/session table. A server-rendered client can keep the centrally issued short-lived
token in a host-only HttpOnly cookie and validate or introspect it centrally on requests. Keep the
token out of browser JavaScript, validate issuer/audience/expiration, and use the OIDC `sub` as the
same central user ID. Register only the exact callback needed for this localhost or external-domain
fallback.

## Acceptance checks

Before considering a first-party integration complete, verify:

1. A signed-out request produces an anonymous request context and redirects to the central sign-in
   URL when the route requires authentication.
2. A signed-in request forwards the cookie server-to-server with caching disabled and exposes only
   sanitized user/session fields.
3. A valid central session returns through `return_to` without another GitHub prompt.
4. HTTP URLs, credentials, deceptive `syntax.fm` suffixes, and external return hosts are ignored.
5. App authorization still blocks authenticated users without the required app role.
6. Central POST sign-out clears the cookie across Syntax apps, with every `Set-Cookie` header
   preserved.
