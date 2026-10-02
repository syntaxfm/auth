// Serves a production build of local Syntax Auth with `vite preview`, as the Docker image does, on
// a free port with its own temporary D1, and sends it requests with explicit Host headers: browsers
// on auth.syntax.test (as the local HTTPS proxy forwards them, Origin unchanged), browsers on
// localhost, and app servers calling http://localhost with a .syntax.test browser's cookie.
// (`wrangler dev` would be simpler, but it rewrites a same-host https Origin to http.)
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { request as http_request, type IncomingHttpHeaders } from 'node:http';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

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

const LOOPBACK_SESSION_COOKIE = 'better-auth.session_token';
const SYNTAX_TEST_SESSION_COOKIE = '__Secure-better-auth.session_token';
const SYNTAX_TEST_HOST = 'auth.syntax.test';
const SYNTAX_TEST_ORIGIN = 'https://auth.syntax.test';

let port = 0;
let loopback_host = '';
let loopback_origin = '';
// vite preview keeps D1 in .wrangler/state beside wrangler.jsonc, so it runs from a temporary root
// that links to this repo's files and holds its own .wrangler/state and .dev.vars.local.
let temp_root = '';
let persist_dir = '';
let server_group: number | undefined;
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
}

function send(path: string, { host, method = 'GET', headers = {}, body }: RequestOptions) {
	return new Promise<Reply>((resolve, reject) => {
		const request = http_request(
			{ host: '127.0.0.1', port, path, method, headers: { ...headers, host } },
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

function assert_shared_cookie(attributes: Map<string, string>) {
	assert.equal(attributes.get('domain'), '.syntax.test');
	assert.ok(attributes.has('secure'), 'The cookie must be Secure');
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

// An app server forwarding a https://syntax.test or https://*.syntax.test browser's cookie.
function sign_out_from_app(cookie: string, app_origin: string) {
	return post_json('/api/auth/sign-out', loopback_host, app_origin, {}, cookie);
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
	},
	{ timeout: BUILD_TIMEOUT_MS + 2 * WRANGLER_COMMAND_TIMEOUT_MS + START_TIMEOUT_MS }
);

async function clean_up() {
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
		`Local Syntax Auth answers only localhost and auth.syntax.test, so it refused this request for "${hostname}". Open ${loopback_origin} or https://auth.syntax.test instead.`,
		what
	);
}

test('local mode refuses every host but localhost and auth.syntax.test, naming the host', async () => {
	for (const host of [
		'example.com',
		'syntax.test',
		'lab.syntax.test',
		'auth.syntax.test.example.com'
	]) {
		const reply = await send('/sign-in', {
			host,
			headers: { cookie: `${SYNTAX_TEST_SESSION_COOKIE}=forwarded.cookie` }
		});
		assert_host_refused(reply, host, host);
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

	// Vite's own host check would let the IP address and the *.localhost name through.
	for (const host of ['evil.example', `evil.example:${port}`, '10.0.0.1', 'evil.localhost']) {
		for (const path of paths) {
			assert_host_refused(await send(path, { host }), host, `${host}${path}`);
		}
	}

	for (const host of [
		loopback_host,
		'localhost',
		`127.0.0.1:${port}`,
		`[::1]:${port}`,
		SYNTAX_TEST_HOST
	]) {
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
		LOOPBACK_SESSION_COOKIE
	);
	loopback_cookie = pair;

	assert.equal(attributes.has('domain'), false);
	assert.equal(attributes.has('secure'), false);
	assert.ok(attributes.has('httponly'));
	assert.equal(attributes.get('samesite')?.toLowerCase(), 'lax');
	assert.equal((await get_session_user_id(loopback_host, pair)).user_id, LOCAL_DEVELOPER.id);
});

let syntax_test_cookie = '';

test('auth.syntax.test signs in the local developer with the shared .syntax.test cookie', async () => {
	const { pair, attributes } = get_cookie(
		await sign_in(SYNTAX_TEST_HOST, SYNTAX_TEST_ORIGIN),
		SYNTAX_TEST_SESSION_COOKIE
	);
	syntax_test_cookie = pair;

	assert_shared_cookie(attributes);
	assert.equal(
		(await get_session_user_id(SYNTAX_TEST_HOST, pair)).user_id,
		LOCAL_DEVELOPER.id,
		'auth.syntax.test reads its own cookie'
	);
});

test('the sign-in page returns only to https syntax.test app URLs without credentials', async () => {
	const open_sign_in = (return_to: string) =>
		send(`/sign-in?return_to=${encodeURIComponent(return_to)}`, {
			host: SYNTAX_TEST_HOST,
			headers: { cookie: syntax_test_cookie }
		});

	for (const kept of ['https://lab.syntax.test/x', 'https://syntax.test/']) {
		const reply = await open_sign_in(kept);
		assert.equal(reply.status, 303, kept);
		assert.equal(reply.headers.location, kept);
	}

	for (const dropped of [
		'http://lab.syntax.test/',
		'https://u:p@lab.syntax.test/',
		'https://lab.syntax.test.example.com/',
		'https://syntax.test.example/'
	]) {
		const reply = await open_sign_in(dropped);
		assert.equal(reply.status, 200, dropped);
		assert.equal(reply.headers.location, undefined, dropped);
	}
});

test('app servers on localhost read and refresh a session made at auth.syntax.test', async () => {
	const fresh = await get_session_user_id(loopback_host, syntax_test_cookie);
	assert.equal(fresh.user_id, LOCAL_DEVELOPER.id);
	assert.equal(fresh.reply.set_cookies.length, 0, 'A fresh session needs no refresh');

	// Better Auth refreshes a session once less than six of its seven days remain.
	const token = decodeURIComponent(syntax_test_cookie.split('=')[1]).split('.')[0];
	assert.match(token, /^[\w-]+$/);
	await d1_execute(
		`UPDATE session SET expires_at = ${Date.now() + 5 * DAY_MS} WHERE token = '${token}'`
	);

	const refreshed = await get_session_user_id(loopback_host, syntax_test_cookie);
	assert.equal(refreshed.user_id, LOCAL_DEVELOPER.id);
	const { attributes } = get_cookie(refreshed.reply, SYNTAX_TEST_SESSION_COOKIE);
	assert_shared_cookie(attributes);
	assert.equal(attributes.get('max-age'), String((7 * DAY_MS) / 1000));
});

test('app servers on localhost sign out a .syntax.test session only for syntax.test origins', async () => {
	const look_alike = await sign_out_from_app(
		syntax_test_cookie,
		'https://lab.syntax.test.example.com'
	);
	assert.equal(look_alike.status, 403);
	assert.deepEqual(JSON.parse(look_alike.body), {
		code: 'INVALID_ORIGIN',
		message:
			'Local Syntax Auth refused a request from origin "https://lab.syntax.test.example.com": it accepts only http://localhost:<port>, http://127.0.0.1:<port>, https://syntax.test, and https://*.syntax.test. Open the app at one of those addresses.'
	});
	assert.equal(
		(await get_session_user_id(loopback_host, syntax_test_cookie)).user_id,
		LOCAL_DEVELOPER.id,
		'A refused sign-out keeps the session'
	);

	const second_cookie = get_cookie(
		await sign_in(SYNTAX_TEST_HOST, SYNTAX_TEST_ORIGIN),
		SYNTAX_TEST_SESSION_COOKIE
	).pair;

	for (const [cookie, app_origin] of [
		[syntax_test_cookie, 'https://lab.syntax.test'],
		[second_cookie, 'https://syntax.test']
	]) {
		const reply = await sign_out_from_app(cookie, app_origin);
		assert.equal(reply.status, 200, `${app_origin}: ${reply.body}`);
		const { attributes } = get_cookie(reply, SYNTAX_TEST_SESSION_COOKIE);
		assert.equal(attributes.get('max-age'), '0');
		assert.equal(attributes.get('domain'), '.syntax.test');
		assert.equal((await get_session_user_id(loopback_host, cookie)).user_id, null, app_origin);
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
			'Local Syntax Auth refused a request from origin "http://localhost.example.com:3000": it accepts only http://localhost:<port>, http://127.0.0.1:<port>, https://syntax.test, and https://*.syntax.test. Open the app at one of those addresses.'
	});

	const reply = await post_json(
		'/api/auth/sign-out',
		loopback_host,
		loopback_origin,
		{},
		loopback_cookie
	);
	assert.equal(reply.status, 200, reply.body);
	assert.equal(get_cookie(reply, LOOPBACK_SESSION_COOKIE).attributes.get('max-age'), '0');
	assert.equal((await get_session_user_id(loopback_host, loopback_cookie)).user_id, null);
});
