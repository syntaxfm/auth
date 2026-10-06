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
the same on `localhost`, on a LAN or VPN address, and on an HTTPS name you run yourself. None of it
needs secrets, a GitHub OAuth App, hosts-file entries, certificates, or an HTTPS proxy set up for
you.

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

   An app that serves some paths from another local server (a sync or WebSocket server, for
   example) lists them, and the dev server proxies them, HTTP and WebSocket, from the app's own
   address:

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
- **Sign out.** Either render the form below, which posts to the development proxy at the app's
  own address and returns to `return_to` (default `/`), or keep the app's own `POST` sign-out
  endpoint and have its server call local Syntax Auth, as described next. Both work on every
  address and sign out centrally. There is no GET sign-out. Either way, local Syntax Auth ends the
  session of every local session cookie the `Cookie` header carries (see "Cookies and sessions
  per address") and answers with a `Set-Cookie` header clearing each.

```html
<form method="post" action="/__syntax_auth/sign-out">
	<input type="hidden" name="return_to" value="/" />
	<button>Sign out</button>
</form>
```

### Signing out from the app's own server

An app's own sign-out endpoint works for any browser origin the app itself has validated, on
`localhost` or any other address, when its server does what the development proxy does:

1. Accept only `POST`. Read the browser's `Origin` and accept it only when it equals, exactly
   (scheme, host, and port), one of the origins the app can prove for this request: the request
   URL's own origin (the connection's scheme and the `Host` header) or a configured public origin
   (`SYNTAX_AUTH_PUBLIC_ORIGINS`, below) with that very host and port. Never derive an origin from
   `X-Forwarded-Host`, `X-Forwarded-Proto`, `Forwarded`, or any other header a client can send.
   Refuse a missing or `null` `Origin`, and a `Sec-Fetch-Site` other than `same-origin` when one
   is sent.
2. Call `POST http://localhost:37960/api/auth/sign-out` with the browser's whole `Cookie` header
   unchanged, `Cache-Control: no-store`, `Origin: <the checked origin>`, and
   `x-syntax-auth-dev-origin: <the same origin>`. Build these headers on the server rather than
   copying the incoming request's headers through.
3. Forward every returned `Set-Cookie` header to the browser as its own header, unchanged, on
   success and on failure, and return to the app with a relative `Location` (such as `/`).

`x-syntax-auth-dev-origin` belongs only on this server-to-loopback call. Local Syntax Auth reads
it only in local mode, only on its loopback names, and only when it is a bare http or https origin.
If `Origin` is present, it must match that value; a mismatch gets a 403 and a malformed private
header gets a 400. The service also accepts a valid private header without `Origin` from a
loopback caller. Consumer servers must still validate the browser origin and send both headers
as described above. The service trusts that one origin for the request and clears cookies for
its scheme. An app must
ignore any copy a client sends to the app (never forward or trust it; the value it sends is the
one it checked itself), and never send the header to production. Without the header, local Syntax
Auth trusts only `http://localhost:<port>` and `http://127.0.0.1:<port>` origins.

### What the app server is responsible for

The development proxy's limits (below) cover only the proxy's own calls. An app server's direct
calls to `http://localhost:37960` (get-session and sign-out) need their own:

- **One deadline per call, including any body read.** Session validation must bound both
  response headers and reading the whole body; Syntax's own apps use 5 seconds. A development
  build may also ask get-session without a cookie, so a stopped local Syntax Auth shows as an
  outage rather than a sign-in that can't work; that anonymous call gets the same deadline.
  A sign-out consumer that uses only the status and cookies may discard the body immediately
  instead of reading it. It must not wait indefinitely on an unused body or claim to validate it.
- **The browser's request ends the call.** Where the runtime gives the incoming request an abort
  signal, pass it on: a request that already ended sends nothing, and one that ends partway
  cancels the call and its body.
- **The exact `Cookie` header.** Use a fetch that sends it byte for byte. In SvelteKit that is the
  global `fetch`, not `event.fetch`, which rebuilds the `Cookie` header for requests to the page's
  own hostname, such as `localhost`.
- **Separate `Set-Cookie` headers.** Keep them as soon as the response headers arrive, so a body
  that then fails or passes the deadline still forwards a refresh or a clear, each as its own
  header.
- **No redirects followed, nothing repeated.** Don't follow a redirect from local Syntax Auth
  (`redirect: 'manual'`); treat a non-2xx answer or an unreadable session body as a failure. Never
  retry a call by itself.

How a signed-out or failed request is answered depends on its kind, and that is the app's job, in
the form its framework expects:

- A document `GET` may redirect to sign-in, or show a page that names the problem and its fix with
  a **Try again** link the person chooses.
- A client-side data request or remote read sent as `GET` gets the framework's own redirect or
  error answer for that kind of request (a plain `302` to a `fetch` is followed silently). Use what
  the framework itself sends; don't invent a format.
- Anything other than `GET` (form actions, commands, mutations) gets an error, never a redirect,
  and is never replayed.

Nothing reloads or retries by itself, so an outage can't loop.

### Addresses

- **`localhost`** works out of the box, on any port.
- **A LAN or VPN IP address** (`http://192.0.2.10:5173`, or an IPv6 address such as
  `http://[2001:db8::10]:5173`) works once the dev server listens on the network, which stays
  opt-in: for example `pnpm dev --host`, or the app's own way of setting Vite's `server.host`.
- **Any other name**, over http or https, is set per developer, without editing the app, in
  `SYNTAX_AUTH_PUBLIC_ORIGINS` (origins separated by commas or spaces), for example
  `SYNTAX_AUTH_PUBLIC_ORIGINS=http://dev.example.com:5173,https://app.example.com pnpm dev`.
  The plugin adds each origin's name to Vite's `server.allowedHosts` (never `allowedHosts: true`),
  and the proxy accepts that origin. An app may also pass `public_origins` to the plugin. Vite's
  own `__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS` lets a name through Vite's host check too, but only
  `SYNTAX_AUTH_PUBLIC_ORIGINS` tells the proxy a name is https.
- **HTTPS you run yourself** (a local TLS proxy such as Caddy, or a managed HTTPS name that
  forwards to this computer, like `https://app.example.com`): point it at the dev server, keep the
  browser's `Host` header unchanged, and list the https origin in `SYNTAX_AUTH_PUBLIC_ORIGINS`. The
  proxy reads the scheme from the connection itself (Vite's own `server.https` counts) or from
  that list, never from `X-Forwarded-Proto` or any other header a client could send. A sign-in from
  an https address the list doesn't name is refused with that fix. A public origin counts only for
  its own host and port; one listed for another host, or for this host on another port, is never
  accepted. An app server that checks origins itself ("Signing out from the app's own server")
  reads the same list the same way.

### Cookies and sessions per address

Cookies are host-only: a sign-in on http sets `better-auth.session_token`, and one on https sets
`__Secure-better-auth.session_token` with `Secure`, each with `Path=/; HttpOnly; SameSite=Lax` and
no `Domain`. So each host name keeps its own session: `localhost`, `127.0.0.1`, a LAN address, and
`dev.example.com` each sign in separately, even when they reach the same app. Cookies ignore ports,
so every app on one name shares that name's session: signing in to one app on `localhost` signs
you in to every app on `localhost`, whatever its port, and signing out of one signs out of all of
them. The app server's calls to `http://localhost:37960` read, refresh, and delete either cookie
under its own name and attributes. A browser can hold both for one name, because a plain cookie
from a name's http address also reaches its https address (and browsers send `__Secure-` cookies
to `http://localhost`). Then:

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
- Each of the proxy's own waits has a limit: a form of at most 4 KB arriving within 10 seconds; local Syntax Auth
  accepting within 5 seconds and answering within 15, with at most 64 KB; a route accepting within
  5 seconds, starting its answer within 30, with a request body of at most 1 MB and an exchange
  idle for at most 2 minutes. A routed WebSocket upgrade must get a complete, valid `101` answer
  head (at most 16 KB) within those 30 seconds; only then does the tunnel start, with no limit on
  its lifetime. A refused upgrade gets its error answer, then its connection is closed once the
  client closes its side, or after 2 seconds at most. A refused, closed, stalled, malformed, oversized, or redirecting
  answer shows a page that names it, plus what local Syntax Auth's start reported, with a **Try
  again** link (or, for a sign-out, a button) the person chooses; the dev server log gets the same
  line, without cookies or tokens.

The proxy tells local Syntax Auth the browser origin it checked in the private
`x-syntax-auth-dev-origin` header on sign-in and sign-out, as an app's own sign-out does, and drops
any copy a client sent, including on routed requests. Local Syntax Auth reads it only in local
mode, only on its loopback names, and only when it is a bare http or https origin (no wildcard,
path, or credentials). A malformed one gets a 400; if `Origin` is present and differs, it gets a 403. A loopback caller may omit `Origin`, but the development proxy and consumer sign-out servers
send both checked headers. The service trusts that origin for the request and picks the cookie
for its scheme.
Browsers can't send the header to `localhost:37960` themselves: it needs a CORS preflight, which
local Syntax Auth never grants. Deployed Syntax Auth never reads it.

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

The Docker image, `ghcr.io/syntaxfm/auth-local`, is private to the Syntax team. The plugin first
tries a plain `docker pull`, so an existing GitHub Container Registry login that can read it
works. Otherwise, for syntaxfm members, it pulls with their GitHub CLI login in a throwaway Docker
config, so the token is never stored and existing Docker logins are untouched. Team members need:

- Docker: Docker Desktop or OrbStack on macOS, or Docker Engine on Linux, usable by their user;
- the GitHub CLI, signed in with `gh auth login` (its default scopes include `read:org`, which the
  membership check needs);
- active membership of the `syntaxfm` GitHub organization (a pending invite must be accepted);
- once per machine, `gh auth refresh -h github.com -s read:packages`.

Each missing piece produces one warning naming it and its fix. Anyone without access still runs
the app, signed out.

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
The per-app development proxy above supersedes that architecture: its `syntax-auth-local setup`
command and its localhost redirects are gone, and local Syntax Auth no longer answers
`auth.syntax.test`. Nothing removes what it added, and leaving it in place doesn't affect the
current setup. Syntax Auth's `README.md` describes how to inspect it and remove only what it
added, if you want to.

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
   HTTPS address the developer uses, and the app's sign-out ends that session on each of them.
8. In development, a failed or signed-out non-`GET` request gets an error rather than a redirect,
   and nothing is retried or replayed by itself.
9. A production build uses `https://auth.syntax.fm` and rejects `http://localhost` return and
   sign-out origins.
