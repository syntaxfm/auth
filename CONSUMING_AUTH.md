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

## Local development

`localhost` cannot receive the production `.syntax.fm` cookie, so every app runs one shared local
Syntax Auth on `http://localhost:37960`, and each app's own dev server serves sign-in and sign-out
at the app's own address. A browser never needs to reach `localhost:37960` itself, so an app works
the same on `localhost`, on a LAN or Tailscale address, and on an HTTPS name you run yourself. None
of it needs secrets, 1Password, a GitHub OAuth App, hosts-file entries, certificates, or an HTTPS
proxy set up for you.

### Set up the app

1. Add `@syntaxfm/auth-local` as a dev dependency and add its Vite plugin. The package installs
   from a subdirectory of this repository, which currently requires pnpm:

   ```sh
   pnpm add -D "github:syntaxfm/auth#path:/packages/auth-local"
   ```

   ```ts
   import { syntax_auth } from '@syntaxfm/auth-local';

   export default defineConfig({
   	plugins: [syntax_auth(), sveltekit()]
   });
   ```

   An app that serves some paths from another local server (Lab's sync server) lists them, and the
   dev server proxies them, HTTP and WebSocket, from the app's own address:

   ```ts
   syntax_auth({ routes: [{ path: '/parties/*', port: 1348 }] });
   ```

   A route is an exact path or a `/prefix/*` with plain segments, on a port of this computer other
   than 37960. The plugin applies only to `vite dev` (never a build, a preview, or Vitest), and it
   never changes the hosts file, certificates, an HTTPS proxy, or anything else outside the dev
   server, and never redirects. The old `name` and `port` options are accepted and ignored.

2. Use `http://localhost:37960` as the Syntax Auth origin for server calls in development builds and
   keep `https://auth.syntax.fm` fixed in code for production builds, so no environment setting can
   point production elsewhere.

3. Sign in with **Continue as Local Developer**. That account always has the central user ID
   `local-developer`. Make the app's existing local setup (seed, migration, or setup script) give
   this ID the roles needed for development, idempotently, so no manual step is required.
   Production never issues this ID.

### The development contract

Production's contract above stays as it is. In development builds:

- **Session check.** The app server calls `GET http://localhost:37960/api/auth/get-session` with
  the browser's `Cookie` header unchanged, exactly as in production, and appends every returned
  `Set-Cookie` header to its response unchanged.
- **Sign in.** Send a signed-out browser to the app's own
  `/__syntax_auth/sign-in?return_to=<path>`, where `<path>` is the app-relative path and query to
  come back to (such as `/compositions/1?tab=a`), built with a URL API. Redirect with a relative
  `Location` (the path alone), never an absolute URL, so it works on any address and scheme
  without the app guessing either. The page signs in with one button and returns to `<path>`;
  anything but a path on the same app (an absolute or `//` URL, a backslash, a control character,
  or a `/__syntax_auth/` path) returns to `/`. A browser already signed in goes straight back.
- **Sign out.** Render a form that posts to the app's own address, as below. It signs out
  centrally and returns to `return_to` (default `/`). There is no GET sign-out. An app server may
  still call `POST http://localhost:37960/api/auth/sign-out` itself with the browser's whole
  `Cookie` header and its own origin as `Origin`, but local Syntax Auth accepts that only from
  `http://localhost:<port>` and `http://127.0.0.1:<port>`; apps on any other address use the form.
  Either way, it ends the session of every local session cookie the `Cookie` header carries (see
  below) and answers with a `Set-Cookie` header clearing each, which the app forwards one by one,
  unchanged.

```html
<form method="post" action="/__syntax_auth/sign-out">
	<input type="hidden" name="return_to" value="/" />
	<button>Sign out</button>
</form>
```

### Addresses

- **`localhost`** works out of the box, on any port.
- **A LAN or Tailscale IP address** (`http://192.168.1.20:5173`, `http://100.101.102.103:5173`, or
  an IPv6 address) works once the dev server listens on the network, which stays opt-in: for
  example `pnpm dev --host`, or the app's own way of setting Vite's `server.host`.
- **Any other name**, over http or https, is set per developer, without editing the app, in
  `SYNTAX_AUTH_PUBLIC_ORIGINS` (origins separated by commas or spaces), for example
  `SYNTAX_AUTH_PUBLIC_ORIGINS=http://box.tail1234.ts.net:5173,https://lab.example.dev pnpm dev`.
  The plugin adds each origin's name to Vite's `server.allowedHosts` (never `allowedHosts: true`),
  and the proxy accepts that origin. An app may also pass `public_origins` to the plugin. Vite's
  own `__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS` lets a name through Vite's host check too, but only
  `SYNTAX_AUTH_PUBLIC_ORIGINS` tells the proxy a name is https.
- **HTTPS you run yourself** (Caddy, `tailscale serve`, or another TLS proxy): point it at the dev
  server, keep the browser's `Host` header unchanged, and list the https origin in
  `SYNTAX_AUTH_PUBLIC_ORIGINS`. The proxy reads the scheme from the connection itself (Vite's own
  `server.https` counts) or from that list, never from `X-Forwarded-Proto` or any other header a
  client could send. A sign-in from an https address the list doesn't name is refused with that
  fix.

Cookies are host-only: a sign-in on http sets `better-auth.session_token`, and one on https sets
`__Secure-better-auth.session_token` with `Secure`, each with `Path=/; HttpOnly; SameSite=Lax` and
no `Domain`. Each name keeps its own session, so signing in on one doesn't sign in on another. The
app server's calls to `http://localhost:37960` read, refresh, and delete either cookie under its
own name and attributes. A browser can hold both for one name, because cookies ignore ports and a
plain cookie from a name's http address also reaches its https address (and browsers send
`__Secure-` cookies to `http://localhost`). Then:

- get-session reads the `__Secure-` one, as before (and as Better Auth's `getSessionCookie` does);
- sign-out ends both sessions, whichever address it comes from, clearing each cookie in its own
  `Set-Cookie` header; a sign-out that fails stops there and is never repeated;
- a sign-in on http also expires a `__Secure-` session cookie the browser sent, which would
  otherwise be read before the new one; that older session itself is left alone, and a sign-in on
  https leaves a plain cookie alone.

### What the development proxy accepts

The proxy answers only `/__syntax_auth/sign-in` (GET, HEAD, POST), `/__syntax_auth/sign-out`
(POST), and the configured routes; every other path is the app's own. It fails closed:

- It answers only the hosts Vite's host check allows (IP addresses, `localhost`, `*.localhost`,
  `server.allowedHosts`) plus the public origins' names, and checks them itself even where Vite
  doesn't (an https dev server, or `allowedHosts: true`), so a page that points its own name at
  this computer (DNS rebinding) gets a 403.
- Every sign-in, sign-out, routed request other than GET, HEAD, and OPTIONS, and routed WebSocket
  upgrade must carry an `Origin` equal to the app's own origin, and a `Sec-Fetch-Site` (when sent)
  of `same-origin`. A missing, `null`, foreign, other-scheme, or other-port origin gets a 403.
- Its pages can't be framed, cached, or used to load anything else (`Content-Security-Policy`,
  `X-Frame-Options: DENY`, `Cache-Control: no-store`).
- It makes exactly four calls to local Syntax Auth on `127.0.0.1:37960`, each with the browser's
  `Cookie` header: `get-session`, `sign-in/email` (then `sign-up/email` once, on a fresh database's
  first sign-in, as Syntax Auth's own sign-in page does), and `sign-out`. It never forwards any
  other Auth API, never follows a redirect, and never retries. A browser that leaves (closes its
  connection or stream) cancels the call in flight and every step after it, so a sign-in it left
  never goes on to create the account. It passes on only their `Set-Cookie` headers, each as its
  own header; their bodies, which hold the session token, never reach the browser, a page, or the
  log.
- A route's request goes only to `127.0.0.1:<its port>`, with its original path and `Host`. A path
  with a `.` or `..` segment, an empty segment, a backslash, or an encoded dot, slash, or backslash,
  and any request target that isn't a plain path (such as an absolute URL), is refused.
- Each wait has a limit: a form of at most 4 KB arriving within 10 seconds; local Syntax Auth
  accepting within 5 seconds and answering within 15, with at most 64 KB; a route accepting within
  5 seconds, starting its answer within 30, with a request body of at most 1 MB and an exchange
  idle for at most 2 minutes. A routed WebSocket upgrade must get a complete, valid `101` answer
  head (at most 16 KB) within those 30 seconds; only then does the tunnel start, with no limit on
  its lifetime. A refused upgrade gets its error answer, then its connection is closed once the
  client closes its side, or after 2 seconds at most. A refused, closed, stalled, malformed, oversized, or redirecting
  answer shows a page that names it, plus what local Syntax Auth's start reported, with a **Try
  again** link (or, for a sign-out, a button) the person chooses; the dev server log gets the same
  line, without cookies or tokens.

The proxy tells local Syntax Auth the browser origin it checked in a private
`x-syntax-auth-dev-origin` header on sign-in and sign-out, and drops any copy a client sent. Local
Syntax Auth reads it only in local mode, only on its loopback names, and only when it is a bare
http or https origin (no wildcard, path, or credentials) equal to the request's `Origin`; a
malformed one gets a 400 and a mismatched one a 403. It then trusts that one origin for that
request and picks the cookie for its scheme. Browsers can't send the header to
`localhost:37960` themselves: it needs a CORS preflight, which local Syntax Auth never grants.
Deployed Syntax Auth never reads it.

### Starting local Syntax Auth

Every dev server start makes sure the one shared `syntax-auth` container is running, on macOS or
Linux, whether or not any other Syntax app is already running, without delaying the dev server.
Any number of apps may start at once: container changes are serialized by a machine-wide lock
that the OS releases even if a process crashes. When Docker already runs, starting the container
shows no dialog, so it happens from any shell. On macOS, when Docker isn't running, the plugin
opens Docker Desktop (or OrbStack) only with a person at the Mac's screen, under the same lock, so
the app is opened only once at a time: a second app starting meanwhile waits for that start and,
if it failed or stalled, prints the same message instead of opening it again. It never opens it:

- from an AI coding agent's shell (`CLAUDECODE` or `PI_CODING_AGENT` set), so an agent checking a
  page never makes a dialog appear in front of you;
- over SSH (`SSH_CONNECTION` or `SSH_TTY` set), in CI (`CI` set), or under a test runner
  (`NODE_TEST_CONTEXT` or `VITEST` set);
- outside the Mac's desktop session (`launchctl managername` isn't `Aqua`).

Each of these variables counts when it is set at all, whatever its value: `CI=`, `CI=0`, and
`CI=false` all mean CI. The app then runs signed out with a message such as "Docker isn't running,
and this dev server was started from an agent shell (PI_CODING_AGENT), so it didn't open Docker
Desktop or OrbStack. Start Docker Desktop (or OrbStack), then restart dev." When you are watching
the screen and want an agent's run to open Docker, start it with `SYNTAX_DEV_SETUP_DIALOGS=allow`;
that switch never works over SSH, in CI, or under a test runner. On Linux, a stopped Docker engine
is named with how to start it.

The plugin pulls newer images and swaps them in from a detached process, keeps local users and
sessions in a Docker volume, and skips Vitest. If Docker is missing or stopped, the image is not
accessible, a command stalls, or another program holds the port, it prints one warning naming the
exact problem and its fix, the app runs signed out, and `/__syntax_auth/sign-in` shows the same
warning. Apps without Vite run the `syntax-auth-local` command before their dev server instead;
without the development proxy they work on `localhost` only, sending browsers to
`http://localhost:37960/sign-in?return_to=<their localhost URL>`. Contributors working on Syntax
Auth itself run `pnpm dev` or `pnpm preview` in this repository, which stops the container and
serves the same port; other apps then use that server. When it stops, it starts the container
again.

The Docker image is private to the Syntax team. For syntaxfm members, the plugin pulls it with
their GitHub CLI login in a throwaway Docker config, so the token is never stored and existing
Docker logins are untouched. Team members need Docker and a signed-in GitHub CLI
(`gh auth login`), plus once per machine `gh auth refresh -h github.com -s read:packages`. Anyone
without access still runs the app, signed out.

### Local mode

Local mode turns on only when Syntax Auth runs on a loopback URL without a shared cookie domain. In
that mode it answers only `localhost`, `127.0.0.1`, and `[::1]`, uses its own local D1 state and a
development-only signing secret, and replaces GitHub with the local developer account. In the
container, and under `pnpm dev` in this repository, every request for any other host, including
`/api/health` and built files, gets a plain-text 403 that names the host and the address to use
instead. A request from an origin it doesn't trust gets a 403 with code `INVALID_ORIGIN` and a
message naming that origin and the origins it accepts. Its sessions are meaningless to production.
The container publishes its port on `127.0.0.1` only.

### Leaving the old `.syntax.test` setup

Earlier versions set up `https://syntax.test`, `https://lab.syntax.test`, and
`https://auth.syntax.test` on macOS (a hosts-file block, Caddy routes, and trust in Caddy's root).
That setup, its `syntax-auth-local setup` command, and its localhost redirects are gone, and local
Syntax Auth no longer answers `auth.syntax.test`. Nothing removes what it added; Syntax Auth's
`README.md` shows how to undo each step by hand, if you want to.

## External domains

For an app outside `syntax.fm`, use this service's OIDC provider:

- Issuer: `https://auth.syntax.fm/api/auth`
- Discovery: `https://auth.syntax.fm/api/auth/.well-known/openid-configuration`
- Flow: Authorization Code with PKCE (`S256`), state, and nonce
- Identity scopes: `openid profile email`

Use a maintained OIDC client and discover endpoints from metadata. This flow does not require
a local user/session table. A server-rendered client can keep the centrally issued short-lived
token in a host-only HttpOnly cookie and validate or introspect it centrally on requests. Keep the
token out of browser JavaScript, validate issuer/audience/expiration, treat any validation or
introspection failure as signed out, and use the OIDC `sub` as the same central user ID. Do not add a
second user or session database. Register only the exact callback needed for the external domain.

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
7. On a machine where no other Syntax app is running, the app's dev command alone starts local
   Syntax Auth, and **Continue as Local Developer** at the app's own `/__syntax_auth/sign-in`
   returns to the app signed in with its development roles, on `localhost` and on any network or
   HTTPS address the developer uses.
8. A production build uses `https://auth.syntax.fm` and rejects `http://localhost` return and
   sign-out origins.
