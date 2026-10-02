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
Syntax Auth on `http://localhost:37960`. Cookies are shared across ports on the same host, so its
host-only cookie reaches the app on any other `localhost` port, and the integration code is
identical to production. It needs no secrets, 1Password, or GitHub OAuth App.

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

   Every dev server start then makes sure the one shared `syntax-auth` container is running,
   whether or not any other Syntax app is already running, without delaying the dev server. Any number of
   apps may start at once: container changes are serialized by a machine-wide lock that the OS
   releases even if a process crashes. It opens Docker Desktop (or OrbStack) on macOS when needed,
   under the same lock, so the app is opened only once at a time: a second app starting meanwhile
   waits for that start and, if it failed, prints the same message instead of opening it again. It
   pulls newer
   images and swaps them in from a detached process, keeps local users and sessions in a Docker
   volume, and skips Vitest. If Docker is missing or stopped, the image is not accessible, or
   another program holds the port, it prints one warning naming the exact problem and its fix, and
   the app runs signed out. Apps without Vite run the
   `syntax-auth-local` command before their dev server instead. Contributors working on Syntax Auth
   itself run `pnpm dev` or `pnpm preview` in this repository, which stops the container and serves
   the same port; other apps then use that server. When it stops, it starts the container again.

   The Docker image is private to the Syntax team. For syntaxfm members, the plugin pulls it with
   their GitHub CLI login in a throwaway Docker config, so the token is never stored and existing
   Docker logins are untouched. Team members need Docker and a signed-in GitHub CLI
   (`gh auth login`), plus once per machine `gh auth refresh -h github.com -s read:packages`.
   Anyone without access still runs the app, signed out.

2. Use `http://localhost:37960` as the Syntax Auth origin in development builds and keep
   `https://auth.syntax.fm` fixed in code for production builds, so no environment setting can
   point production elsewhere. Use the origin for `get-session`, `sign-in`, and `sign-out`. Accept
   `http://localhost` and `http://127.0.0.1` `return_to` and sign-out origins only in development
   builds, plus `https://syntax.test` and `https://*.syntax.test` for apps on the local HTTPS names
   below.
3. The app may run on any port. Local Syntax Auth accepts any `http://localhost` or
   `http://127.0.0.1` port for `return_to`, sign-in, and sign-out.
4. Sign in with **Continue as Local Developer**. That account always has the central user ID
   `local-developer`. Make the app's existing local setup (seed, migration, or setup script) give
   this ID the roles needed for development, idempotently, so no manual step is required.
   Production never issues this ID.

Local mode turns on only when Syntax Auth runs on a loopback URL without a shared cookie domain. In
that mode it answers only `localhost`, `127.0.0.1`, `[::1]`, and `auth.syntax.test`, uses its own
local D1 state and a development-only signing secret, and replaces GitHub with the local developer
account. In the container, and under `pnpm dev` in this repository, every request for any other
host, including `/api/health` and built files, gets a plain-text 403 that names the host and the
two addresses to use instead. A request from an origin it doesn't trust gets a 403 with code
`INVALID_ORIGIN` and a message naming that origin and the origins it accepts:
`http://localhost:<port>`, `http://127.0.0.1:<port>`, `https://syntax.test`, and
`https://*.syntax.test`. Its sessions are meaningless to production. The container publishes its port on `127.0.0.1` only.

### Local HTTPS names

Syntax apps can also run locally on three HTTPS names, served by a local HTTPS proxy:
`https://syntax.test` (the website), `https://lab.syntax.test` (Lab), and `https://auth.syntax.test`
(local Syntax Auth). On those names, as in production, one cookie on the parent domain
(`.syntax.test`) signs a browser in to every app.

Give the plugin the app's name to set its name up whenever its dev server starts (never under
Vitest or in a build). `port` is where the name forwards, by default the port Vite listens on; an
app whose dev server sits behind another (Lab under `alchemy dev`) passes that one. `routes` sends
paths to other local servers:

```ts
syntax_auth({ name: 'lab', port: 1337, routes: [{ path: '/parties/*', port: 1999 }] });
```

On macOS, each start makes sure of these steps, in order, without delaying the dev server. A step
that is already done is skipped, so after the first start nothing asks again:

1. **Hosts file.** `/etc/hosts` gets any missing `127.0.0.1` and `::1` entries for the three names,
   in one block marked `# >>> syntax.test` … `# <<< syntax.test`. Changing it asks for your password
   (or Touch ID) in a macOS dialog. A fixed script, never a file anyone could edit, then checks the
   file is still the one setup planned from (if another program changed it while the dialog was
   open, it changes nothing and says so), saves it as `/etc/hosts.syntax-test.bak`, rewrites only
   that block through a copy moved into place, and clears the DNS cache; an interrupted edit leaves
   the old file or the new one. Every byte outside the block stays as it was, CRLF line endings and
   a missing final newline included, and a name another line points elsewhere is left alone and
   reported. A damaged block (a marker without its partner, two blocks, or an altered marker line)
   is refused with its fix. One setup runs at a time on the machine, and a dialog left open closes
   after 5 minutes.
2. **HTTPS proxy.** If Caddy's admin API answers on `127.0.0.1:2019` and is proven to be Caddy
   (it answers as Caddy's does, and the one program listening on `127.0.0.1:2019`, or on a wildcard
   address that covers it, is `caddy`), setup adds its routes there, first in the port 443 server,
   and leaves every other route alone. If a route it didn't add matches a name at any depth (inside
   a subroute, in a host list, or by a wildcard such as `*.syntax.test`), setup names that route and
   changes nothing. Otherwise it starts Syntax's
   own `syntax-caddy` container from the official Caddy image, pinned by digest, published on
   `127.0.0.1` only (ports 443, 80, and 2019), with its certificates in a Docker volume; a program
   already on one of those ports is named instead, and if setup can't read which programs listen,
   it stops rather than assume the ports are free. Each name gets a route with the `@id`
   `syntax-test-<name>` (`syntax-test-auth` forwards to port 37960 on every start), plus one
   `tls internal` certificate policy, `syntax-test-tls`. Only this computer and its tailnet
   (`100.64.0.0/10`) get through; any other client gets a 403. While dev runs, setup checks every
   15 seconds and adds the routes back if Caddy lost them (a restart or `caddy reload`).
3. **Certificate trust.** Setup reads the root certificate from that Caddy's own certificate
   authority, checks that it issued the certificate Caddy serves for the names, and trusts it in
   your login keychain with one macOS approval. A root that didn't issue it is refused, with the
   reason. If you decline, the certificate macOS added is removed again.
4. **Final check.** The names resolve to this computer, Caddy has the routes, macOS trusts the
   certificate, and `https://<name>` reaches this very dev server.

Then the dev server prints `https://<name> is ready.`, and page loads on `localhost` (or
`127.0.0.1`) go to the same path on the https name; scripts' requests are never redirected. If a
step fails, the dev server prints the step, what failed, and its fix, keeps running on `localhost`,
and answers page loads there with a page naming the same, with a link to keep that browser on
`localhost` for now. A retry (restart dev) is always safe, and a command that stalls is stopped
with a message naming it.

Setup shows its password and approval dialogs only when a person is likely at the Mac's screen.
It shows none, changes nothing, and prints each fix when dev (or `syntax-auth-local setup`)
starts:

- from an AI coding agent's shell (`CLAUDECODE` or `PI_CODING_AGENT` set), so an agent checking
  a page never makes a dialog appear in front of you;
- over SSH (`SSH_CONNECTION` or `SSH_TTY` set), in CI (`CI` set), or under a test runner
  (`NODE_TEST_CONTEXT` or `VITEST` set);
- outside the Mac's desktop session (`launchctl managername` isn't `Aqua`).

Its first line says which one, for example "Started from an agent shell (PI_CODING_AGENT), so
setup didn't show any dialogs and changed nothing." Each fix after it is a command to run in
Terminal at the Mac's own screen, such as
`pnpm exec syntax-auth-local setup lab --port 1337 --route '/parties/*=1999'` (the dev server
prints it with its own port and routes); `setup lab` and `setup website` need `--port`. When you
are watching the screen and want an agent's run to show the dialogs, start it with
`SYNTAX_DEV_SETUP_DIALOGS=allow`, for example `SYNTAX_DEV_SETUP_DIALOGS=allow pnpm dev`. That
switch never works over SSH, in CI, or under a test runner. An agent's dev server still opens
Docker and starts the local Syntax Auth container when needed, since neither shows one of
setup's dialogs.

On Linux and Windows setup changes nothing and says that automatic setup is macOS-only for now.
There, and over SSH, in CI, under a test runner, or outside the desktop session, a named dev
server also leaves Docker and the local Syntax Auth container alone: if Syntax Auth isn't
running, it says to start it with `pnpm exec syntax-auth-local`. The routes stay in Caddy when dev stops; Syntax Auth's `README.md`
shows how to undo every step.

On those names:

- Send browsers to `https://auth.syntax.test`, for example
  `https://auth.syntax.test/sign-in?return_to=<encoded app URL>`. Local Syntax Auth accepts
  `return_to` URLs on `https://syntax.test` and `https://*.syntax.test` without credentials, and
  drops `http` URLs and look-alike hosts such as `lab.syntax.test.example.com`.
- Keep the app server's calls on `http://localhost:37960`: `get-session` with the browser's
  `Cookie` header unchanged, and `POST /api/auth/sign-out` with that header and the app's own
  HTTPS origin (such as `https://lab.syntax.test`) as `Origin`. Forward every returned `Set-Cookie`
  header to the browser unchanged.
- Signing in at `https://auth.syntax.test` sets `__Secure-better-auth.session_token` with
  `Domain=.syntax.test; Path=/; Secure; HttpOnly; SameSite=Lax`. When an app server forwards that
  cookie to `http://localhost:37960`, local Syntax Auth reads it, refreshes it, and deletes it with
  the same name and attributes.
- Apps still on `http://localhost` keep working unchanged, with their own host-only sessions. A
  browser signed in on one set of names is signed out on the other.

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
   Syntax Auth, and **Continue as Local Developer** returns to the app signed in with its
   development roles.
8. A production build uses `https://auth.syntax.fm` and rejects `http://localhost` return and
   sign-out origins.
