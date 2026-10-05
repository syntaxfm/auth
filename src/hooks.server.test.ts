// Serves a production build of local Syntax Auth with `vite preview`, as the Docker image does, on
// a free port with its own temporary D1, and sends it requests with explicit Host headers: browsers
// on localhost, app servers calling http://localhost with a browser's cookie, and browsers on other
// addresses (a LAN address, a developer's own https name) signing in through an app's development
// proxy, the real one from packages/auth-local, run here in front of it.
// (`wrangler dev` would be simpler, but it rewrites a same-host https Origin to http.)
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import {
	createServer as create_http_server,
	request as http_request,
	type IncomingHttpHeaders,
	type Server
} from 'node:http';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { create_gateway } from '../packages/auth-local/gateway.js';
import { create_local_auth_caller } from '../packages/auth-local/local_auth.js';
import { DEV_ORIGIN_HEADER } from './lib/server/dev_proxy';
import { LOCAL_DEVELOPER } from './lib/server/local_developer';

const BUILD_TIMEOUT_MS = 180_000;
const WRANGLER_COMMAND_TIMEOUT_MS = 60_000;
const START_TIMEOUT_MS = 60_000;
const REQUEST_TIMEOUT_MS = 15_000;
const STOP_GRACE_MS = 5_000;
const OUTPUT_TAIL_LENGTH = 4_000;
const DAY_MS = 86_400_000;

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const BIN = join(REPO_ROOT, 'node_modules', '.bin');
const CHILD_ENV = { ...process.env, WRANGLER_SEND_METRICS: 'false' };

const SESSION_COOKIE = 'better-auth.session_token';
const SECURE_SESSION_COOKIE = '__Secure-better-auth.session_token';
// Browsers on an app's LAN address, and on a developer's own https name in front of it.
const LAN_HOST = '192.168.1.20:5173';
const LAN_ORIGIN = 'http://192.168.1.20:5173';
const HTTPS_HOST = 'lab.example.dev';
const HTTPS_ORIGIN = 'https://lab.example.dev';
// The same name over http, before its TLS proxy is in front.
const SAME_HOST_HTTP_ORIGIN = 'http://lab.example.dev';

let port = 0;
let loopback_host = '';
let loopback_origin = '';
// vite preview keeps D1 in .wrangler/state beside wrangler.jsonc, so it runs from a temporary root
// that links to this repo's files and holds its own .wrangler/state and .dev.vars.local.
let temp_root = '';
let persist_dir = '';
let server_group: number | undefined;
// An app's development proxy, with no app behind it.
let gateway_port = 0;
let gateway_server: Server | undefined;
// Commands still running, stopped on cleanup when a timeout or a signal cuts the run short.
const command_groups = new Set<number>();
let server_output = '';

function sleep(ms: number) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function tail(output: string) {
	return output.slice(-OUTPUT_TAIL_LENGTH).trim();
}

function is_group_running(group_id: number) {
	try {
		process.kill(-group_id, 0);
		return true;
	} catch {
		return false;
	}
}

function signal_group(group_id: number, signal: NodeJS.Signals) {
	try {
		process.kill(-group_id, signal);
	} catch {
		// Every process in the group has already exited.
	}
}

// A server and its children (Wrangler's workerd, for one) share a process group, so one signal
// reaches them all.
async function stop_group(group_id: number) {
	for (const signal of ['SIGTERM', 'SIGKILL'] as const) {
		signal_group(group_id, signal);
		const deadline = Date.now() + STOP_GRACE_MS;
		while (is_group_running(group_id) && Date.now() < deadline) await sleep(100);
		if (!is_group_running(group_id)) return;
	}
}

// Runs a command in its own process group and stops the whole group if it outlives its timeout.
function run(what: string, command: string, args: string[], timeout_ms: number): Promise<string> {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, { cwd: REPO_ROOT, env: CHILD_ENV, detached: true });
		const group_id = child.pid;
		if (group_id) command_groups.add(group_id);
		let output = '';
		child.stdout.on('data', (chunk) => (output += chunk));
		child.stderr.on('data', (chunk) => (output += chunk));

		const timer = setTimeout(() => {
			if (group_id) void stop_group(group_id);
			reject(
				new Error(
					`${what} didn't finish within ${timeout_ms / 1000} s, so the test stopped it. Its output so far:\n${tail(output)}`
				)
			);
		}, timeout_ms);

		child.once('error', (error) => {
			clearTimeout(timer);
			reject(new Error(`${what} couldn't start (${error.message}). Run pnpm install, then retry.`));
		});
		child.once('close', (code) => {
			clearTimeout(timer);
			if (group_id) command_groups.delete(group_id);
			if (code === 0) resolve(output);
			else
				reject(
					new Error(`${what} failed with exit code ${code}. Fix this, then retry:\n${tail(output)}`)
				);
		});
	});
}

function get_free_port(): Promise<number> {
	return new Promise((resolve, reject) => {
		const server = createServer();
		server.once('error', reject);
		server.listen(0, '127.0.0.1', () => {
			const address = server.address();
			server.close(() =>
				typeof address === 'object' && address
					? resolve(address.port)
					: reject(new Error('The OS gave no free port on 127.0.0.1.'))
			);
		});
	});
}

interface Reply {
	status: number;
	headers: IncomingHttpHeaders;
	set_cookies: string[];
	body: string;
}

interface RequestOptions {
	host: string;
	method?: string;
	headers?: Record<string, string>;
	body?: string;
	// The app's development proxy, rather than local Syntax Auth itself.
	through_proxy?: boolean;
}

function send(
	path: string,
	{ host, method = 'GET', headers = {}, body, through_proxy = false }: RequestOptions
) {
	return new Promise<Reply>((resolve, reject) => {
		const request = http_request(
			{
				host: '127.0.0.1',
				port: through_proxy ? gateway_port : port,
				path,
				method,
				headers: { ...headers, host }
			},
			(response) => {
				let response_body = '';
				response.setEncoding('utf8');
				response.on('data', (chunk) => (response_body += chunk));
				response.once('end', () =>
					resolve({
						status: response.statusCode ?? 0,
						headers: response.headers,
						set_cookies: response.headers['set-cookie'] ?? [],
						body: response_body
					})
				);
			}
		);
		request.setTimeout(REQUEST_TIMEOUT_MS, () =>
			request.destroy(
				new Error(`${method} ${host}${path} got no reply within ${REQUEST_TIMEOUT_MS / 1000} s.`)
			)
		);
		request.once('error', reject);
		request.end(body);
	});
}

function post_json(path: string, host: string, origin: string, body: unknown, cookie?: string) {
	return send(path, {
		host,
		method: 'POST',
		headers: {
			origin,
			'content-type': 'application/json',
			...(cookie ? { cookie } : {})
		},
		body: JSON.stringify(body)
	});
}

// The cookie's `name=value` pair and its attributes, keyed by lowercase attribute name.
function get_cookie(reply: Reply, name: string) {
	const header = reply.set_cookies.find((cookie) => cookie.startsWith(`${name}=`));
	assert.ok(header, `No ${name} cookie among: ${JSON.stringify(reply.set_cookies)}`);

	const [pair, ...attribute_parts] = header.split(';').map((part) => part.trim());
	const attributes = new Map(
		attribute_parts.map((part) => {
			const [key, ...value] = part.split('=');
			return [key.toLowerCase(), value.join('=')] as const;
		})
	);
	return { pair, attributes };
}

function get_cookie_names(reply: Reply) {
	return reply.set_cookies.map((cookie) => cookie.split('=')[0]);
}

// Every local cookie is host-only; only a browser on https gets a Secure one.
function assert_host_only_cookie(attributes: Map<string, string>, is_secure: boolean) {
	assert.equal(attributes.has('domain'), false, 'The cookie must have no Domain');
	assert.equal(
		attributes.has('secure'),
		is_secure,
		`The cookie must ${is_secure ? '' : 'not '}be Secure`
	);
	assert.ok(attributes.has('httponly'), 'The cookie must be HttpOnly');
	assert.equal(attributes.get('samesite')?.toLowerCase(), 'lax');
	assert.equal(attributes.get('path'), '/');
}

// Signs in as the page's Continue as Local Developer button does: sign-up on a fresh database.
async function sign_in(host: string, origin: string) {
	const { email, password, name } = LOCAL_DEVELOPER;
	let reply = await post_json('/api/auth/sign-in/email', host, origin, { email, password });
	if (reply.status === 401) {
		reply = await post_json('/api/auth/sign-up/email', host, origin, { email, password, name });
	}
	assert.equal(reply.status, 200, reply.body);
	return reply;
}

async function get_session_user_id(host: string, cookie: string) {
	const reply = await send('/api/auth/get-session', { host, headers: { cookie } });
	assert.equal(reply.status, 200, reply.body);
	const session = JSON.parse(reply.body) as { user: { id: string } } | null;
	return { reply, user_id: session?.user.id ?? null };
}

// A browser's form post to the app's development proxy.
function post_to_proxy(
	path: string,
	host: string,
	origin: string,
	fields: Record<string, string>,
	cookie?: string
) {
	return send(path, {
		host,
		method: 'POST',
		through_proxy: true,
		headers: {
			origin,
			'content-type': 'application/x-www-form-urlencoded',
			...(cookie ? { cookie } : {})
		},
		body: new URLSearchParams(fields).toString()
	});
}

// The session token in a session cookie's `name=value` pair, without its signature.
function session_token(cookie: string) {
	const token = decodeURIComponent(cookie.split('=')[1]).split('.')[0];
	assert.match(token, /^[\w-]+$/);
	return token;
}

// Makes the session behind `cookie` due for Better Auth's refresh, which comes once less than six of
// its seven days remain.
async function age_session(cookie: string) {
	await d1_execute(
		`UPDATE session SET expires_at = ${Date.now() + 5 * DAY_MS} WHERE token = '${session_token(cookie)}'`
	);
}

function start_gateway(): Promise<number> {
	gateway_server = create_http_server((request, response) =>
		create_gateway_once().handle(request, response, () => {
			response.writeHead(404);
			response.end('not the proxy');
		})
	);
	return new Promise((resolve, reject) => {
		gateway_server?.once('error', reject);
		gateway_server?.listen(0, '127.0.0.1', () => {
			const address = gateway_server?.address();
			if (typeof address === 'object' && address) resolve(address.port);
			else reject(new Error('The development proxy got no port.'));
		});
	});
}

let gateway: ReturnType<typeof create_gateway> | undefined;
function create_gateway_once() {
	gateway ??= create_gateway({
		routes: [],
		// And https on localhost, as a TLS proxy there would serve it.
		public_origins: [HTTPS_ORIGIN, `https://localhost:${gateway_port}`],
		allowed_hosts: () => [],
		call_local_auth: create_local_auth_caller({ port }),
		startup_problem: () => null,
		warn: (message) => void (server_output += `\n[proxy] ${message}`)
	});
	return gateway;
}

function d1_execute(sql: string) {
	return run(
		'Updating the temporary D1 with wrangler d1 execute',
		join(BIN, 'wrangler'),
		[
			'd1',
			'execute',
			'syntax-auth',
			'--local',
			'--env',
			'local',
			'--persist-to',
			persist_dir,
			'--yes'
		].concat(['--command', sql]),
		WRANGLER_COMMAND_TIMEOUT_MS
	);
}

async function wait_until_healthy() {
	const deadline = Date.now() + START_TIMEOUT_MS;
	while (Date.now() < deadline) {
		if (server_group === undefined || !is_group_running(server_group)) break;
		const reply = await send('/api/health', { host: loopback_host }).catch(() => null);
		if (reply?.status === 200) return;
		await sleep(250);
	}
	throw new Error(
		`vite preview didn't answer /api/health on port ${port} within ${START_TIMEOUT_MS / 1000} s. Fix the error below, then retry:\n${tail(server_output)}`
	);
}

// vite.config.ts imports from src.
const LINKED_FILES = [
	'node_modules',
	'src',
	'.svelte-kit',
	'package.json',
	'vite.config.ts',
	'svelte.config.js',
	'wrangler.jsonc'
];

before(
	async () => {
		port = await get_free_port();
		loopback_host = `localhost:${port}`;
		loopback_origin = `http://localhost:${port}`;
		temp_root = await mkdtemp(join(tmpdir(), 'syntax-auth-test-'));
		persist_dir = join(temp_root, '.wrangler', 'state');
		for (const file of LINKED_FILES) await symlink(join(REPO_ROOT, file), join(temp_root, file));
		await writeFile(join(temp_root, '.dev.vars.local'), `BETTER_AUTH_URL=${loopback_origin}\n`);

		await run('pnpm build (vite build)', join(BIN, 'vite'), ['build'], BUILD_TIMEOUT_MS);
		await run(
			'Applying migrations to the temporary D1',
			join(BIN, 'wrangler'),
			['d1', 'migrations', 'apply', 'syntax-auth', '--local', '--env', 'local'].concat([
				'--persist-to',
				persist_dir
			]),
			WRANGLER_COMMAND_TIMEOUT_MS
		);

		const server = spawn(
			join(BIN, 'vite'),
			['preview', '--host', '127.0.0.1', '--port', String(port), '--strictPort'],
			{ cwd: temp_root, env: CHILD_ENV, detached: true }
		);
		server_group = server.pid;
		server.stdout.on('data', (chunk) => (server_output += chunk));
		server.stderr.on('data', (chunk) => (server_output += chunk));
		server.once('error', (error) => (server_output += `\nvite preview couldn't start: ${error}`));

		await wait_until_healthy();
		gateway_port = await start_gateway();
	},
	{ timeout: BUILD_TIMEOUT_MS + 2 * WRANGLER_COMMAND_TIMEOUT_MS + START_TIMEOUT_MS }
);

async function clean_up() {
	gateway_server?.closeAllConnections();
	gateway_server?.close();
	const groups = [...command_groups, ...(server_group === undefined ? [] : [server_group])];
	await Promise.all(groups.map(stop_group));
	// Removes the links themselves, never what they point to.
	if (temp_root) await rm(temp_root, { recursive: true, force: true });
}

after(clean_up);

// The server runs in its own process group, so Ctrl-C on the test run doesn't reach it.
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
	process.once(signal, () => void clean_up().finally(() => process.exit(1)));
}

function assert_host_refused(reply: Reply, host: string, what: string) {
	const hostname = new URL(`http://${host}`).hostname;
	assert.equal(reply.status, 403, what);
	assert.equal(reply.headers['content-type'], 'text/plain; charset=utf-8', what);
	assert.equal(
		reply.body,
		`Local Syntax Auth answers only localhost, 127.0.0.1, and [::1], so it refused this request for "${hostname}". Open ${loopback_origin} instead, or sign in through your app's own /__syntax_auth/sign-in.`,
		what
	);
}

test('local mode refuses every host but its loopback names, naming the host', async () => {
	for (const host of [
		'example.com',
		'auth.syntax.test',
		'syntax.test',
		'lab.syntax.test',
		HTTPS_HOST,
		LAN_HOST,
		'localhost.example.com'
	]) {
		const reply = await send('/sign-in', {
			host,
			headers: { cookie: `${SECURE_SESSION_COOKIE}=forwarded.cookie` }
		});
		assert_host_refused(reply, host, host);
		// Proxy metadata doesn't change that.
		const vouched = await send('/api/auth/get-session', {
			host,
			headers: { [DEV_ORIGIN_HEADER]: HTTPS_ORIGIN }
		});
		assert_host_refused(vouched, host, `${host} with proxy metadata`);
	}
});

// A page in another tab can point its own name at 127.0.0.1 (DNS rebinding), so health checks and
// built files must be refused for it too, though Vite answers them before SvelteKit's hook.
test('other hosts get the same 403 for health checks, built files, and pages', async () => {
	const page = await send('/sign-in', { host: loopback_host });
	assert.equal(page.status, 200, page.body);
	const asset = page.body.match(/_app\/immutable\/assets\/[^"'?]+\.css/)?.[0];
	assert.ok(asset, `The sign-in page links no built CSS file:\n${page.body}`);
	const paths = ['/api/health', '/_app/version.json', `/${asset}`, '/sign-in'];

	// Vite's own host check would let the IP addresses and the *.localhost name through.
	for (const host of [
		'evil.example',
		`evil.example:${port}`,
		'10.0.0.1',
		'evil.localhost',
		'auth.syntax.test'
	]) {
		for (const path of paths) {
			assert_host_refused(await send(path, { host }), host, `${host}${path}`);
		}
	}

	for (const host of [loopback_host, 'localhost', `127.0.0.1:${port}`, `[::1]:${port}`]) {
		for (const path of paths) {
			const reply = await send(path, { host });
			assert.equal(reply.status, 200, `${host}${path}: ${reply.body.slice(0, 500)}`);
		}
	}
});

let loopback_cookie = '';

test('a browser on localhost still gets the host-only session cookie', async () => {
	const { pair, attributes } = get_cookie(
		await sign_in(loopback_host, loopback_origin),
		SESSION_COOKIE
	);
	loopback_cookie = pair;

	assert_host_only_cookie(attributes, false);
	assert.equal((await get_session_user_id(loopback_host, pair)).user_id, LOCAL_DEVELOPER.id);
});

test('the sign-in page still returns only to https syntax.test app URLs without credentials', async () => {
	const open_sign_in = (return_to: string) =>
		send(`/sign-in?return_to=${encodeURIComponent(return_to)}`, {
			host: loopback_host,
			headers: { cookie: loopback_cookie }
		});

	for (const kept of [
		'https://lab.syntax.test/x',
		'https://syntax.test/',
		`${loopback_origin}/x`
	]) {
		const reply = await open_sign_in(kept);
		assert.equal(reply.status, 303, kept);
		assert.equal(reply.headers.location, kept);
	}

	for (const dropped of [
		'http://lab.syntax.test/',
		'https://u:p@lab.syntax.test/',
		'https://lab.syntax.test.example.com/',
		'https://syntax.test.example/',
		`${HTTPS_ORIGIN}/x`
	]) {
		const reply = await open_sign_in(dropped);
		assert.equal(reply.status, 200, dropped);
		assert.equal(reply.headers.location, undefined, dropped);
	}
});

for (const scene of [
	{
		what: 'a LAN address',
		host: LAN_HOST,
		origin: LAN_ORIGIN,
		name: SESSION_COOKIE,
		secure: false
	},
	{
		what: "a developer's own https name",
		host: HTTPS_HOST,
		origin: HTTPS_ORIGIN,
		name: SECURE_SESSION_COOKIE,
		secure: true
	}
]) {
	test(`a browser on ${scene.what} signs in, refreshes, and signs out through the app's own proxy`, async () => {
		// The sign-in page, then its button.
		const page = await send('/__syntax_auth/sign-in?return_to=%2Fa%3Fb%3D1', {
			host: scene.host,
			through_proxy: true
		});
		assert.equal(page.status, 200, page.body);
		assert.match(page.body, /Continue as Local Developer/);
		const signed_in = await post_to_proxy('/__syntax_auth/sign-in', scene.host, scene.origin, {
			return_to: '/a?b=1'
		});
		assert.equal(signed_in.status, 303, signed_in.body);
		assert.equal(signed_in.headers.location, '/a?b=1');
		assert.equal(signed_in.body, '');
		const { pair, attributes } = get_cookie(signed_in, scene.name);
		assert_host_only_cookie(attributes, scene.secure);

		// The app server reads it at http://localhost, as for any browser.
		assert.equal((await get_session_user_id(loopback_host, pair)).user_id, LOCAL_DEVELOPER.id);
		const fresh = await get_session_user_id(loopback_host, pair);
		assert.equal(fresh.reply.set_cookies.length, 0, 'A fresh session needs no refresh');

		// Its refresh keeps the name and attributes, with no Domain, so the app can pass it on.
		await age_session(pair);
		const refreshed = await get_session_user_id(loopback_host, pair);
		assert.equal(refreshed.user_id, LOCAL_DEVELOPER.id);
		const refreshed_cookie = get_cookie(refreshed.reply, scene.name);
		assert_host_only_cookie(refreshed_cookie.attributes, scene.secure);
		assert.equal(refreshed_cookie.attributes.get('max-age'), String((7 * DAY_MS) / 1000));

		// Signed in, the proxy's page goes straight back.
		const again = await send('/__syntax_auth/sign-in?return_to=/c', {
			host: scene.host,
			through_proxy: true,
			headers: { cookie: pair }
		});
		assert.equal(again.status, 303);
		assert.equal(again.headers.location, '/c');

		// An app server can't sign it out at http://localhost from this origin: only the proxy
		// vouches for it.
		const direct = await post_json('/api/auth/sign-out', loopback_host, scene.origin, {}, pair);
		assert.equal(direct.status, 403);
		assert.equal(JSON.parse(direct.body).code, 'INVALID_ORIGIN');
		assert.equal((await get_session_user_id(loopback_host, pair)).user_id, LOCAL_DEVELOPER.id);

		const signed_out = await post_to_proxy(
			'/__syntax_auth/sign-out',
			scene.host,
			scene.origin,
			{ return_to: '/bye' },
			pair
		);
		assert.equal(signed_out.status, 303, signed_out.body);
		assert.equal(signed_out.headers.location, '/bye');
		const cleared = get_cookie(signed_out, scene.name);
		assert.equal(cleared.attributes.get('max-age'), '0');
		assert.equal(cleared.attributes.has('domain'), false);
		assert.equal((await get_session_user_id(loopback_host, pair)).user_id, null);

		for (const reply of [page, signed_in, again, signed_out]) {
			assert.doesNotMatch(reply.body, /"token"/);
		}
	});
}

// A browser sends a plain cookie from a name's http address to its https address too, so app servers
// read it there, and the https sign-out must end it.
test("signing out at a name's https address ends the session of the plain cookie from its http address", async () => {
	const signed_in = await post_to_proxy(
		'/__syntax_auth/sign-in',
		HTTPS_HOST,
		SAME_HOST_HTTP_ORIGIN,
		{ return_to: '/' }
	);
	assert.equal(signed_in.status, 303, signed_in.body);
	const plain = get_cookie(signed_in, SESSION_COOKIE);
	assert_host_only_cookie(plain.attributes, false);
	assert.equal(get_cookie_names(signed_in).includes(SECURE_SESSION_COOKIE), false);

	// At the https address, with only that cookie: signed in.
	assert.equal((await get_session_user_id(loopback_host, plain.pair)).user_id, LOCAL_DEVELOPER.id);
	const page = await send('/__syntax_auth/sign-in?return_to=/x', {
		host: HTTPS_HOST,
		through_proxy: true,
		headers: { cookie: plain.pair }
	});
	assert.equal(page.status, 303, page.body);

	const signed_out = await post_to_proxy(
		'/__syntax_auth/sign-out',
		HTTPS_HOST,
		HTTPS_ORIGIN,
		{ return_to: '/bye' },
		plain.pair
	);
	assert.equal(signed_out.status, 303, signed_out.body);
	assert.equal(signed_out.headers.location, '/bye');
	const cleared = get_cookie(signed_out, SESSION_COOKIE);
	assert.equal(cleared.pair, `${SESSION_COOKIE}=`);
	assert.equal(cleared.attributes.get('max-age'), '0');
	assert_host_only_cookie(cleared.attributes, false);
	assert.equal((await get_session_user_id(loopback_host, plain.pair)).user_id, null);
	for (const reply of [signed_in, page, signed_out]) assert.doesNotMatch(reply.body, /"token"/);
});

test("signing out with both of a name's cookies ends both sessions, each cleared, and no other", async () => {
	// Another address's session, which this browser never sends.
	const elsewhere = get_cookie(await sign_in(loopback_host, loopback_origin), SESSION_COOKIE).pair;

	const plain = get_cookie(
		await post_to_proxy('/__syntax_auth/sign-in', HTTPS_HOST, SAME_HOST_HTTP_ORIGIN, {}),
		SESSION_COOKIE
	).pair;
	// The https sign-in, with the plain cookie along, issues only its own cookie.
	const secure_reply = await post_to_proxy(
		'/__syntax_auth/sign-in',
		HTTPS_HOST,
		HTTPS_ORIGIN,
		{},
		plain
	);
	assert.equal(secure_reply.status, 303, secure_reply.body);
	const secure = get_cookie(secure_reply, SECURE_SESSION_COOKIE);
	assert_host_only_cookie(secure.attributes, true);
	assert.equal(get_cookie_names(secure_reply).includes(SESSION_COOKIE), false);

	const both = `${plain}; theme=dark; ${secure.pair}`;
	for (const cookie of [plain, secure.pair, both]) {
		assert.equal((await get_session_user_id(loopback_host, cookie)).user_id, LOCAL_DEVELOPER.id);
	}

	const signed_out = await post_to_proxy(
		'/__syntax_auth/sign-out',
		HTTPS_HOST,
		HTTPS_ORIGIN,
		{ return_to: '/bye' },
		both
	);
	assert.equal(signed_out.status, 303, signed_out.body);
	// Each cookie cleared in its own header, under its own name and attributes.
	const cleared_plain = get_cookie(signed_out, SESSION_COOKIE);
	assert.equal(cleared_plain.pair, `${SESSION_COOKIE}=`);
	assert.equal(cleared_plain.attributes.get('max-age'), '0');
	assert_host_only_cookie(cleared_plain.attributes, false);
	const cleared_secure = get_cookie(signed_out, SECURE_SESSION_COOKIE);
	assert.equal(cleared_secure.pair, `${SECURE_SESSION_COOKIE}=`);
	assert.equal(cleared_secure.attributes.get('max-age'), '0');
	assert_host_only_cookie(cleared_secure.attributes, true);
	assert.equal(
		signed_out.set_cookies.filter((cookie) =>
			/^(?:__Secure-)?better-auth\.session_token=/.test(cookie)
		).length,
		2
	);

	for (const cookie of [plain, secure.pair, both]) {
		assert.equal((await get_session_user_id(loopback_host, cookie)).user_id, null, cookie);
	}
	assert.equal((await get_session_user_id(loopback_host, elsewhere)).user_id, LOCAL_DEVELOPER.id);
	for (const reply of [secure_reply, signed_out]) assert.doesNotMatch(reply.body, /"token"/);
});

// Cookies ignore ports, and browsers send __Secure- cookies to http://localhost too.
test('a fresh plain sign-in expires a stale __Secure- cookie that would be read before it', async () => {
	const host = `localhost:${gateway_port}`;
	const secure = get_cookie(
		await post_to_proxy('/__syntax_auth/sign-in', host, `https://${host}`, {}),
		SECURE_SESSION_COOKIE
	).pair;
	// Its session ends without the browser hearing of it (here, its row is deleted).
	await d1_execute(`DELETE FROM session WHERE token = '${session_token(secure)}'`);
	assert.equal((await get_session_user_id(loopback_host, secure)).user_id, null);

	const signed_in = await post_to_proxy(
		'/__syntax_auth/sign-in',
		host,
		`http://${host}`,
		{ return_to: '/a' },
		`${secure}; theme=dark`
	);
	assert.equal(signed_in.status, 303, signed_in.body);
	assert.equal(signed_in.headers.location, '/a');
	const fresh = get_cookie(signed_in, SESSION_COOKIE);
	assert_host_only_cookie(fresh.attributes, false);
	const expired = get_cookie(signed_in, SECURE_SESSION_COOKIE);
	assert.equal(expired.pair, `${SECURE_SESSION_COOKIE}=`);
	assert.equal(expired.attributes.get('max-age'), '0');
	assert_host_only_cookie(expired.attributes, true);

	// Kept, the stale cookie would be read first; expired, the fresh session is.
	assert.equal(
		(await get_session_user_id(loopback_host, `${fresh.pair}; ${secure}`)).user_id,
		null
	);
	assert.equal((await get_session_user_id(loopback_host, fresh.pair)).user_id, LOCAL_DEVELOPER.id);
	assert.doesNotMatch(signed_in.body, /"token"/);
});

test("forged or mismatched proxy metadata is refused, and a foreign origin isn't trusted without it", async () => {
	const { email, password } = LOCAL_DEVELOPER;
	const credentials = JSON.stringify({ email, password });
	for (const [headers, status] of [
		[{ origin: 'https://evil.example', [DEV_ORIGIN_HEADER]: HTTPS_ORIGIN }, 403],
		[{ origin: HTTPS_ORIGIN, [DEV_ORIGIN_HEADER]: 'https://*' }, 400],
		[{ origin: HTTPS_ORIGIN, [DEV_ORIGIN_HEADER]: `${HTTPS_ORIGIN}/` }, 400],
		[{ origin: HTTPS_ORIGIN, [DEV_ORIGIN_HEADER]: 'https://u:p@lab.example.dev' }, 400]
	] as const) {
		const reply = await send('/api/auth/sign-in/email', {
			host: loopback_host,
			method: 'POST',
			headers: { ...headers, 'content-type': 'application/json' },
			body: credentials
		});
		assert.equal(reply.status, status, JSON.stringify(headers));
		assert.match(
			reply.body,
			/^Local Syntax Auth refused a request whose x-syntax-auth-dev-origin header/
		);
		assert.deepEqual(reply.set_cookies, []);
	}

	const foreign = await post_json('/api/auth/sign-in/email', loopback_host, HTTPS_ORIGIN, {
		email,
		password
	});
	assert.equal(foreign.status, 403);
	assert.equal(JSON.parse(foreign.body).code, 'INVALID_ORIGIN');
	assert.deepEqual(foreign.set_cookies, []);

	// Through the proxy, a page on another site, or another scheme, is refused before Syntax Auth.
	for (const origin of ['https://evil.example', `https://${LAN_HOST}`]) {
		const reply = await post_to_proxy('/__syntax_auth/sign-in', LAN_HOST, origin, {});
		assert.equal(reply.status, 403, origin);
		assert.deepEqual(reply.set_cookies, [], origin);
	}
});

test('a session made on localhost still validates and signs out', async () => {
	assert.equal(
		(await get_session_user_id(loopback_host, loopback_cookie)).user_id,
		LOCAL_DEVELOPER.id
	);

	const look_alike = await post_json(
		'/api/auth/sign-out',
		loopback_host,
		'http://localhost.example.com:3000',
		{},
		loopback_cookie
	);
	assert.equal(look_alike.status, 403);
	assert.deepEqual(JSON.parse(look_alike.body), {
		code: 'INVALID_ORIGIN',
		message:
			'Local Syntax Auth refused a request from origin "http://localhost.example.com:3000": it accepts only http://localhost:<port> and http://127.0.0.1:<port>. Apps on any other address sign in and out through their own /__syntax_auth/ paths (@syntaxfm/auth-local).'
	});

	const reply = await post_json(
		'/api/auth/sign-out',
		loopback_host,
		loopback_origin,
		{},
		loopback_cookie
	);
	assert.equal(reply.status, 200, reply.body);
	assert.equal(get_cookie(reply, SESSION_COOKIE).attributes.get('max-age'), '0');
	assert.equal((await get_session_user_id(loopback_host, loopback_cookie)).user_id, null);
});

test("native OAuth clients' token requests reach Better Auth, while other cross-site form posts are still refused", async () => {
	const form_headers = { 'content-type': 'application/x-www-form-urlencoded' };

	// No Origin, as Claude Code and pi send it. Better Auth answers (an unknown client here),
	// not SvelteKit's cross-site refusal.
	const token = await send('/api/auth/oauth2/token', {
		host: loopback_host,
		method: 'POST',
		headers: form_headers,
		body: 'grant_type=authorization_code&code=made-up&client_id=made-up&code_verifier=made-up'
	});
	assert.ok([400, 401].includes(token.status), `${token.status} ${token.body}`);
	assert.equal(typeof JSON.parse(token.body).error, 'string', token.body);

	const revoke = await send('/api/auth/oauth2/revoke', {
		host: loopback_host,
		method: 'POST',
		headers: form_headers,
		body: 'token=made-up&client_id=made-up'
	});
	assert.ok([200, 400, 401].includes(revoke.status), `${revoke.status} ${revoke.body}`);
	assert.doesNotMatch(revoke.body, /Cross-site/);

	for (const headers of [form_headers, { ...form_headers, origin: 'https://evil.example' }]) {
		const consent = await send('/api/auth/oauth2/consent', {
			host: loopback_host,
			method: 'POST',
			headers,
			body: 'accept=true'
		});
		assert.equal(consent.status, 403);
		assert.equal(consent.body, 'Cross-site POST form submissions are forbidden');
	}
});
