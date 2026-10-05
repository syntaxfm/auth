// The development proxy against stand-ins: local Syntax Auth (answering as Better Auth does for the
// four calls the proxy makes), routed servers, and broken upstreams, all on free loopback ports.
import assert from 'node:assert/strict';
import { createServer as create_http_server, request as http_request } from 'node:http';
import { connect, createServer as create_net_server } from 'node:net';
import { after, test } from 'node:test';

import { parse_routes } from '../app_origin.js';
import { DEV_ORIGIN_HEADER, GATEWAY_LIMITS, create_gateway } from '../gateway.js';
import { LOCAL_AUTH_LIMITS, create_local_auth_caller } from '../local_auth.js';
import { LOCAL_DEVELOPER } from '../local_developer.js';
import { free_port } from './stand_ins.js';

/** @type {(() => unknown)[]} */
const cleanups = [];
after(() => Promise.all(cleanups.map((cleanup) => cleanup())));

const TOKEN = 'session-token-that-must-never-reach-the-browser';

/**
 * @param {import('node:http').Server | import('node:net').Server} server
 * @returns {Promise<number>}
 */
function listen(server) {
	cleanups.push(
		() =>
			new Promise((resolve) => {
				if ('closeAllConnections' in server) server.closeAllConnections();
				server.close(() => resolve(undefined));
			})
	);
	return new Promise((resolve) =>
		server.listen(0, '127.0.0.1', () =>
			resolve(/** @type {import('node:net').AddressInfo} */ (server.address()).port)
		)
	);
}

/**
 * @typedef {{ method: string, path: string, headers: import('node:http').IncomingHttpHeaders, body: string }} Recorded
 */

/**
 * Local Syntax Auth, as Better Auth answers the proxy's calls: a 401 sign-in until the account
 * exists, a session cookie named for the browser's scheme (from the proxy's metadata), the token in
 * every JSON answer, and two Set-Cookie headers per answer.
 */
async function start_local_auth() {
	/** @type {Recorded[]} */
	const calls = [];
	const state = { has_account: false };
	const server = create_http_server((request, response) => {
		let body = '';
		request.on('data', (chunk) => (body += chunk));
		request.on('end', () => {
			calls.push({
				method: request.method ?? '',
				path: request.url ?? '',
				headers: request.headers,
				body
			});
			const is_https = String(request.headers[DEV_ORIGIN_HEADER] ?? '').startsWith('https:');
			const name = is_https ? '__Secure-better-auth.session_token' : 'better-auth.session_token';
			const attributes = `Path=/; HttpOnly; SameSite=Lax${is_https ? '; Secure' : ''}`;
			/** @param {number} status @param {unknown} json @param {string[]} cookies */
			const answer = (status, json, cookies) => {
				response.writeHead(status, { 'content-type': 'application/json', 'set-cookie': cookies });
				response.end(JSON.stringify(json));
			};
			const session_cookies = [
				`${name}=${TOKEN}.signed; Max-Age=604800; ${attributes}`,
				`better-auth.dont_remember=; Max-Age=0; ${attributes}`
			];
			const user = { id: LOCAL_DEVELOPER.id, name: LOCAL_DEVELOPER.name };
			if (request.url === '/api/auth/get-session') {
				const cookie = request.headers.cookie ?? '';
				if (!cookie.includes(TOKEN)) return answer(200, null, []);
				return answer(
					200,
					{
						session: {
							id: 'local-session',
							userId: user.id,
							expiresAt: '2030-01-01T00:00:00.000Z',
							token: TOKEN
						},
						user
					},
					session_cookies
				);
			}
			if (request.url === '/api/auth/sign-in/email') {
				if (!state.has_account) {
					return answer(
						401,
						{ code: 'INVALID_EMAIL_OR_PASSWORD', message: 'Invalid email or password' },
						[]
					);
				}
				return answer(200, { token: TOKEN, user }, session_cookies);
			}
			if (request.url === '/api/auth/sign-up/email') {
				state.has_account = true;
				return answer(200, { token: TOKEN, user }, session_cookies);
			}
			if (request.url === '/api/auth/sign-out') {
				return answer(200, { success: true }, [`${name}=; Max-Age=0; ${attributes}`]);
			}
			answer(404, { message: 'Not found' }, []);
		});
	});
	return { port: await listen(server), calls, state };
}

/**
 * An app's dev server with the proxy in front of "app", and its upgrades.
 * @param {Partial<import('../gateway.js').GatewayOptions> & { auth_port: number, auth_limits?: import('../local_auth.js').LocalAuthLimits }} options
 */
async function start_app(options) {
	/** @type {string[]} */
	const warnings = [];
	const gateway = create_gateway({
		routes: [],
		public_origins: [],
		allowed_hosts: () => [],
		startup_problem: () => null,
		warn: (message) => void warnings.push(message),
		call_local_auth: create_local_auth_caller({
			port: options.auth_port,
			limits: options.auth_limits ?? LOCAL_AUTH_LIMITS
		}),
		...options
	});
	const server = create_http_server((request, response) =>
		gateway.handle(request, response, () => response.end('app'))
	);
	/** @type {import('node:stream').Duplex[]} the browser side of each upgrade, as the server holds it */
	const upgrade_sockets = [];
	server.on('upgrade', (request, socket, head) => {
		upgrade_sockets.push(socket);
		if (!gateway.upgrade(request, socket, head)) socket.end('HTTP/1.1 418 Not Ours\r\n\r\n');
	});
	const port = await listen(server);
	return {
		port,
		warnings,
		upgrade_sockets,
		origin: `http://localhost:${port}`,
		host: `localhost:${port}`
	};
}

/**
 * @typedef {{ status: number, headers: import('node:http').IncomingHttpHeaders, body: string }} Reply
 * @param {number} port
 * @param {string} path
 * @param {{ method?: string, headers?: Record<string, string>, body?: string }} [options]
 * @returns {Promise<Reply>}
 */
function send(port, path, { method = 'GET', headers = {}, body } = {}) {
	return new Promise((resolve, reject) => {
		const outgoing = http_request(
			{ host: '127.0.0.1', port, path, method, headers, agent: false },
			(response) => {
				let text = '';
				response.setEncoding('utf8');
				response.on('data', (chunk) => (text += chunk));
				response.on('end', () =>
					resolve({ status: response.statusCode ?? 0, headers: response.headers, body: text })
				);
			}
		);
		outgoing.on('error', reject);
		outgoing.end(body);
	});
}

/**
 * A browser's form post from `origin` to the proxy on `host`.
 * @param {number} port
 * @param {string} path
 * @param {{ host: string, origin?: string, fields?: Record<string, string>, headers?: Record<string, string> }} options
 */
function post_form(port, path, { host, origin, fields = {}, headers = {} }) {
	return send(port, path, {
		method: 'POST',
		headers: {
			host,
			...(origin ? { origin } : {}),
			'content-type': 'application/x-www-form-urlencoded',
			...headers
		},
		body: new URLSearchParams(fields).toString()
	});
}

test('signing in through the app: one button, then back to the app with every cookie and no token', async () => {
	const auth = await start_local_auth();
	const app = await start_app({ auth_port: auth.port });

	const page = await send(
		app.port,
		'/__syntax_auth/sign-in?return_to=%2Fcompositions%2F1%3Ftab%3Da',
		{
			headers: { host: app.host }
		}
	);
	assert.equal(page.status, 200);
	assert.equal(page.headers['content-type'], 'text/html; charset=utf-8');
	assert.equal(page.headers['cache-control'], 'no-store');
	assert.equal(page.headers['x-frame-options'], 'DENY');
	assert.match(String(page.headers['content-security-policy']), /frame-ancestors 'none'/);
	assert.match(page.body, /<form method="post" action="\/__syntax_auth\/sign-in">/);
	assert.match(page.body, /name="return_to" value="\/compositions\/1\?tab=a"/);
	assert.match(page.body, /Continue as Local Developer/);

	const signed_in = await post_form(app.port, '/__syntax_auth/sign-in', {
		host: app.host,
		origin: app.origin,
		fields: { return_to: '/compositions/1?tab=a' },
		headers: { [DEV_ORIGIN_HEADER]: 'https://forged.example', 'sec-fetch-site': 'same-origin' }
	});
	assert.equal(signed_in.status, 303);
	assert.equal(signed_in.headers.location, '/compositions/1?tab=a');
	assert.deepEqual(signed_in.headers['set-cookie'], [
		`better-auth.session_token=${TOKEN}.signed; Max-Age=604800; Path=/; HttpOnly; SameSite=Lax`,
		'better-auth.dont_remember=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax'
	]);
	assert.equal(signed_in.body, '');

	// Sign-in, then sign-up on a fresh database, each once, from the checked origin only.
	const posts = auth.calls.filter((call) => call.method === 'POST');
	assert.deepEqual(
		posts.map((call) => call.path),
		['/api/auth/sign-in/email', '/api/auth/sign-up/email']
	);
	for (const call of posts) {
		assert.equal(call.headers.host, `localhost:${auth.port}`);
		assert.equal(call.headers.origin, app.origin);
		assert.equal(call.headers[DEV_ORIGIN_HEADER], app.origin);
		assert.equal(call.headers.cookie, undefined);
		assert.equal(call.headers['cache-control'], 'no-store');
	}
	assert.deepEqual(JSON.parse(posts[0].body), {
		email: LOCAL_DEVELOPER.email,
		password: LOCAL_DEVELOPER.password
	});
	assert.deepEqual(JSON.parse(posts[1].body), {
		email: LOCAL_DEVELOPER.email,
		password: LOCAL_DEVELOPER.password,
		name: LOCAL_DEVELOPER.name
	});

	// Signed in: the page sends the browser straight back, passing on the refreshed cookies.
	const cookie = `better-auth.session_token=${TOKEN}.signed`;
	const again = await send(app.port, '/__syntax_auth/sign-in?return_to=/x', {
		headers: { host: app.host, cookie }
	});
	assert.equal(again.status, 303);
	assert.equal(again.headers.location, '/x');
	assert.equal(again.headers['set-cookie']?.length, 2);
	const session_check = auth.calls.at(-1);
	assert.equal(session_check?.path, '/api/auth/get-session');
	assert.equal(session_check?.headers.cookie, cookie);
	assert.equal(session_check?.headers[DEV_ORIGIN_HEADER], undefined);

	for (const reply of [page, signed_in, again]) {
		assert.doesNotMatch(reply.body, new RegExp(TOKEN));
		assert.doesNotMatch(JSON.stringify(reply.headers.location ?? ''), new RegExp(TOKEN));
	}
	assert.doesNotMatch(app.warnings.join('\n'), new RegExp(TOKEN));
});

test('a LAN, Tailscale, IPv6, or TLS-proxied https address signs in on its own origin and scheme', async () => {
	const auth = await start_local_auth();
	auth.state.has_account = true;
	const app = await start_app({
		auth_port: auth.port,
		public_origins: ['https://lab.example.dev', 'http://box.tail1234.ts.net:5173']
	});
	for (const [host, origin, cookie_name] of [
		['192.168.1.20:5173', 'http://192.168.1.20:5173', 'better-auth.session_token'],
		['100.101.102.103:5173', 'http://100.101.102.103:5173', 'better-auth.session_token'],
		['[fd7a:115c:a1e0::1]:5173', 'http://[fd7a:115c:a1e0::1]:5173', 'better-auth.session_token'],
		['box.tail1234.ts.net:5173', 'http://box.tail1234.ts.net:5173', 'better-auth.session_token'],
		['lab.example.dev', 'https://lab.example.dev', '__Secure-better-auth.session_token']
	]) {
		const reply = await post_form(app.port, '/__syntax_auth/sign-in', {
			host,
			origin,
			fields: { return_to: '/a' }
		});
		assert.equal(reply.status, 303, `${origin}: ${reply.body}`);
		assert.equal(reply.headers.location, '/a', origin);
		const [session] = reply.headers['set-cookie'] ?? [];
		assert.ok(session.startsWith(`${cookie_name}=`), `${origin}: ${session}`);
		assert.doesNotMatch(session, /domain=/i, origin);
		assert.equal(auth.calls.at(-1)?.headers[DEV_ORIGIN_HEADER], origin);
		assert.equal(auth.calls.at(-1)?.headers.origin, origin);
	}
});

test('foreign, missing, or cross-site origins, other hosts, and unsafe returns never reach local Syntax Auth', async () => {
	const auth = await start_local_auth();
	const app = await start_app({ auth_port: auth.port, allowed_hosts: () => ['lab.example.dev'] });

	for (const [what, headers] of /** @type {const} */ ([
		['no Origin', {}],
		['a null Origin', { origin: 'null' }],
		['another site', { origin: 'https://evil.example' }],
		['another port', { origin: 'http://localhost:1' }],
		['https without a public origin', { origin: `https://${app.host}` }],
		['credentials in the Origin', { origin: `http://user:pass@${app.host}` }],
		['a cross-site fetch', { origin: app.origin, 'sec-fetch-site': 'cross-site' }]
	])) {
		for (const path of ['/__syntax_auth/sign-in', '/__syntax_auth/sign-out']) {
			const reply = await post_form(app.port, path, { host: app.host, headers });
			assert.equal(reply.status, 403, `${what} ${path}`);
			assert.match(reply.body, /refused/, `${what} ${path}`);
		}
	}

	// DNS rebinding: a page whose own name now points here.
	for (const host of ['evil.example', 'evil.example:80', 'lab.example.dev.evil.example']) {
		for (const path of ['/__syntax_auth/sign-in', '/__syntax_auth/sign-out']) {
			const page = await send(app.port, path, { headers: { host } });
			assert.equal(page.status, 403, `${host} GET ${path}`);
			const reply = await post_form(app.port, path, { host, origin: `http://${host}` });
			assert.equal(reply.status, 403, `${host} POST ${path}`);
			assert.match(reply.body, /^Blocked request\. This host/);
		}
	}
	// Only Vite's allowed hosts pass, never a forwarded one.
	const forwarded = await send(app.port, '/__syntax_auth/sign-in', {
		headers: { host: 'evil.example', 'x-forwarded-host': app.host }
	});
	assert.equal(forwarded.status, 403);
	assert.equal(
		(await send(app.port, '/__syntax_auth/sign-in', { headers: { host: 'lab.example.dev' } }))
			.status,
		200
	);
	assert.deepEqual(
		auth.calls.map((call) => call.path),
		['/api/auth/get-session']
	);

	// An absolute target names its own destination: refused rather than followed.
	const absolute = await send(app.port, `http://127.0.0.1:${auth.port}/__syntax_auth/sign-in`, {
		headers: { host: app.host }
	});
	assert.equal(absolute.status, 400);

	auth.state.has_account = true;
	for (const unsafe of [
		'https://evil.example/',
		'//evil.example/',
		'/\\evil.example',
		'/.//evil.example',
		'javascript:alert(1)',
		'/__syntax_auth/sign-out'
	]) {
		const reply = await post_form(app.port, '/__syntax_auth/sign-in', {
			host: app.host,
			origin: app.origin,
			fields: { return_to: unsafe }
		});
		assert.equal(reply.status, 303, unsafe);
		assert.equal(reply.headers.location, '/', unsafe);
		const page = await send(
			app.port,
			`/__syntax_auth/sign-in?return_to=${encodeURIComponent(unsafe)}`,
			{
				headers: { host: app.host }
			}
		);
		assert.match(page.body, /name="return_to" value="\/"/, unsafe);
	}
});

test('signing out through the app forwards the cookie and the checked origin, then returns', async () => {
	const auth = await start_local_auth();
	const app = await start_app({
		auth_port: auth.port,
		public_origins: ['https://lab.example.dev']
	});
	const cookie = `__Secure-better-auth.session_token=${TOKEN}.signed; theme=dark`;
	const reply = await post_form(app.port, '/__syntax_auth/sign-out', {
		host: 'lab.example.dev',
		origin: 'https://lab.example.dev',
		fields: { return_to: '/bye' },
		headers: { cookie }
	});
	assert.equal(reply.status, 303);
	assert.equal(reply.headers.location, '/bye');
	assert.deepEqual(reply.headers['set-cookie'], [
		'__Secure-better-auth.session_token=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax; Secure'
	]);
	const [call] = auth.calls;
	assert.equal(call.path, '/api/auth/sign-out');
	assert.equal(call.headers.cookie, cookie);
	assert.equal(call.headers.origin, 'https://lab.example.dev');
	assert.equal(call.headers[DEV_ORIGIN_HEADER], 'https://lab.example.dev');

	// A form post without a body still signs out, to "/".
	const bare = await send(app.port, '/__syntax_auth/sign-out', {
		method: 'POST',
		headers: { host: app.host, origin: app.origin }
	});
	assert.equal(bare.status, 303);
	assert.equal(bare.headers.location, '/');

	// There is no GET sign-out.
	const get = await send(app.port, '/__syntax_auth/sign-out', { headers: { host: app.host } });
	assert.equal(get.status, 405);
	assert.equal(get.headers.allow, 'POST');
	assert.equal(auth.calls.length, 2);
});

test('only the proxy paths are answered; the rest of the app is untouched', async () => {
	const auth = await start_local_auth();
	const app = await start_app({ auth_port: auth.port });
	for (const path of ['/', '/sign-in', '/api/auth/get-session', '/__syntax_auth_x', '/_app/x.js']) {
		const reply = await send(app.port, path, { headers: { host: 'evil.example' } });
		assert.equal(reply.body, 'app', path);
	}
	for (const path of [
		'/__syntax_auth',
		'/__syntax_auth/',
		'/__syntax_auth/get-session',
		'/__syntax_auth/sign-in/'
	]) {
		const reply = await send(app.port, path, { headers: { host: app.host } });
		assert.equal(reply.status, 404, path);
	}
	const put = await send(app.port, '/__syntax_auth/sign-in', {
		method: 'PUT',
		headers: { host: app.host }
	});
	assert.equal(put.status, 405);
	assert.equal(auth.calls.length, 0);
});

test('a form of the wrong type, too large, or too slow is refused with what is wrong', async () => {
	const auth = await start_local_auth();
	const app = await start_app({
		auth_port: auth.port,
		limits: { ...GATEWAY_LIMITS, form_bytes: 64, form_ms: 200 }
	});
	const base = { host: app.host, origin: app.origin };

	const json = await send(app.port, '/__syntax_auth/sign-in', {
		method: 'POST',
		headers: { ...base, 'content-type': 'application/json' },
		body: '{"return_to":"/"}'
	});
	assert.equal(json.status, 415);

	const large = await post_form(app.port, '/__syntax_auth/sign-in', {
		...base,
		fields: { return_to: `/${'a'.repeat(100)}` }
	});
	assert.equal(large.status, 413);
	assert.match(large.body, /larger than 64 bytes/);

	// Chunked, with no length to refuse up front.
	const chunked = await new Promise((resolve, reject) => {
		const outgoing = http_request(
			{
				host: '127.0.0.1',
				port: app.port,
				path: '/__syntax_auth/sign-in',
				method: 'POST',
				headers: { ...base, 'content-type': 'application/x-www-form-urlencoded' }
			},
			(response) => {
				response.resume();
				response.on('end', () => resolve(response.statusCode));
			}
		);
		outgoing.on('error', reject);
		outgoing.write(`return_to=/${'a'.repeat(100)}`);
	});
	assert.equal(chunked, 413);

	const started = Date.now();
	const slow = await new Promise((resolve, reject) => {
		const outgoing = http_request(
			{
				host: '127.0.0.1',
				port: app.port,
				path: '/__syntax_auth/sign-in',
				method: 'POST',
				headers: { ...base, 'content-type': 'application/x-www-form-urlencoded' }
			},
			(response) => {
				let body = '';
				response.on('data', (chunk) => (body += chunk));
				response.on('end', () => resolve({ status: response.statusCode, body }));
			}
		);
		outgoing.on('error', reject);
		outgoing.write('return_to=');
	});
	assert.ok(Date.now() - started < 2_000);
	assert.deepEqual(/** @type {{ status: number }} */ (slow).status, 408);
	assert.equal(auth.calls.length, 0);
});

/** @param {string} html */
const unescape_html = (html) =>
	html
		.replaceAll('&#39;', "'")
		.replaceAll('&quot;', '"')
		.replaceAll('&lt;', '<')
		.replaceAll('&gt;', '>')
		.replaceAll('&amp;', '&');

/**
 * A raw TCP server standing in for a broken local Syntax Auth; counts its connections.
 * @param {(socket: import('node:net').Socket) => void} behave
 */
async function start_broken(behave) {
	const state = { connections: 0 };
	const server = create_net_server((socket) => {
		state.connections++;
		socket.on('error', () => {});
		behave(socket);
	});
	cleanups.push(() => {
		for (const socket of sockets) socket.destroy();
	});
	/** @type {Set<import('node:net').Socket>} */
	const sockets = new Set();
	server.on('connection', (socket) => sockets.add(socket));
	return { port: await listen(server), state };
}

test('a refused, stalled, closed, malformed, oversized, or redirecting local Syntax Auth fails once, fast, and says which', async () => {
	const limits = { connect_ms: 200, answer_ms: 300, answer_bytes: 1_024 };
	const scenes = [
		{
			name: 'refused',
			port: await free_port(),
			state: { connections: 0 },
			expected: /isn't running at http:\/\/localhost:\d+ \(connection refused\)/
		},
		{
			name: 'stalled',
			...(await start_broken(() => {})),
			expected: /didn't answer \/api\/auth\/sign-in\/email within 300 ms/
		},
		{
			name: 'closed',
			...(await start_broken((socket) =>
				socket.end('HTTP/1.1 200 OK\r\ncontent-length: 50\r\n\r\n{"to')
			)),
			expected: /closed the connection before it finished answering/
		},
		{
			name: 'malformed',
			...(await start_broken((socket) => socket.end('nonsense\r\n\r\n'))),
			expected: /sent an answer that is not valid HTTP/
		},
		{
			name: 'oversized',
			...(await start_broken((socket) =>
				socket.end(`HTTP/1.1 200 OK\r\ncontent-length: 4000\r\n\r\n${'x'.repeat(4_000)}`)
			)),
			expected: /answered \/api\/auth\/sign-in\/email with more than 1024 bytes/
		},
		{
			name: 'redirecting',
			...(await start_broken((socket) =>
				socket.end(
					'HTTP/1.1 302 Found\r\nlocation: https://evil.example/\r\ncontent-length: 0\r\n\r\n'
				)
			)),
			expected:
				/answered \/api\/auth\/sign-in\/email with a redirect \(HTTP 302\), which this proxy never follows/
		}
	];
	for (const scene of scenes) {
		const app = await start_app({
			auth_port: scene.port,
			auth_limits: limits,
			startup_problem: () => "Running signed out: Docker isn't running."
		});
		const started = Date.now();
		const reply = await post_form(app.port, '/__syntax_auth/sign-in', {
			host: app.host,
			origin: app.origin,
			fields: { return_to: '/a' }
		});
		assert.ok(Date.now() - started < 2_000, `${scene.name} took ${Date.now() - started} ms`);
		assert.ok([502, 503].includes(reply.status), `${scene.name}: ${reply.status}`);
		assert.match(unescape_html(reply.body), scene.expected, scene.name);
		assert.equal(reply.headers['set-cookie'], undefined, scene.name);
		assert.equal(reply.headers.location, undefined, scene.name);
		// The retry is a link to the sign-in page, never a repeated post.
		assert.match(
			reply.body,
			/href="\/__syntax_auth\/sign-in\?return_to=%2Fa">Try again</,
			scene.name
		);
		assert.doesNotMatch(reply.body, /at .+\.js:\d+/, scene.name);
		if (reply.status === 503) {
			assert.match(
				reply.body,
				/When this dev server started: Running signed out: Docker isn&#39;t running\./
			);
		}
		if (scene.name !== 'refused') assert.equal(scene.state.connections, 1, scene.name);
		assert.match(app.warnings.join('\n'), scene.expected, scene.name);

		const page = await send(app.port, '/__syntax_auth/sign-in', { headers: { host: app.host } });
		assert.ok([502, 503].includes(page.status), `${scene.name} page: ${page.status}`);
		assert.match(page.body, /Stop this app's dev server/);
		assert.match(page.body, /<code>pnpm dev<\/code>/);
	}
});

test('an Auth refusal identifies its status without exposing its body or messages', async () => {
	const sensitive = 'private-token-and-credential at /private/stack.ts:42';
	const server = create_http_server((_request, response) => {
		response.writeHead(403, { 'content-type': 'application/json' });
		response.end(JSON.stringify({ code: 'INVALID_ORIGIN', message: sensitive, token: TOKEN }));
	});
	const app = await start_app({ auth_port: await listen(server) });
	for (const operation of ['sign-in', 'sign-out']) {
		const reply = await post_form(app.port, `/__syntax_auth/${operation}`, {
			host: app.host,
			origin: app.origin
		});
		assert.equal(reply.status, 502);
		assert.ok(reply.body.includes(`refused the ${operation} (HTTP 403)`));
		assert.ok(!reply.body.includes(sensitive));
		assert.ok(!reply.body.includes(TOKEN));
	}
	assert.ok(!app.warnings.join('\n').includes(sensitive));
	assert.ok(!app.warnings.join('\n').includes(TOKEN));
});

test('malformed keyed session records show a failure rather than redirecting back into a sign-in loop', async () => {
	for (const answer of [
		{ user: null, session: null },
		{ user: { id: 'u' }, session: {} },
		{ user: { id: '' }, session: { id: 's', userId: '', expiresAt: '2030-01-01' } },
		{ user: { id: 'u' }, session: { id: 's', userId: 'other', expiresAt: '2030-01-01' } },
		{ user: { id: 'u' }, session: { id: 's', userId: 'u', expiresAt: 'not-a-date' } }
	]) {
		const server = create_http_server((_request, response) => {
			response.writeHead(200, { 'content-type': 'application/json' });
			response.end(JSON.stringify(answer));
		});
		const app = await start_app({ auth_port: await listen(server) });
		const reply = await send(app.port, '/__syntax_auth/sign-in', { headers: { host: app.host } });
		assert.equal(reply.status, 502, JSON.stringify(answer));
		assert.equal(reply.headers.location, undefined);
		assert.match(reply.body, /unknown shape/);
	}
});

/**
 * A routed server: answers HTTP with what it received, and upgrades by echoing.
 */
async function start_routed() {
	/** @type {Recorded[]} */
	const calls = [];
	/** @type {string[]} */
	const upgrades = [];
	const server = create_http_server((request, response) => {
		let body = '';
		request.on('data', (chunk) => (body += chunk));
		request.on('end', () => {
			calls.push({
				method: request.method ?? '',
				path: request.url ?? '',
				headers: request.headers,
				body
			});
			response.writeHead(201, { 'set-cookie': ['a=1; Path=/', 'b=2; Path=/'], 'x-routed': 'yes' });
			response.end(`routed ${request.url}`);
		});
	});
	server.on('upgrade', (request, socket) => {
		upgrades.push(request.rawHeaders.join('\n'));
		socket.write(
			'HTTP/1.1 101 Switching Protocols\r\nupgrade: websocket\r\nconnection: Upgrade\r\n\r\n'
		);
		socket.on('data', (data) => socket.write(data));
	});
	return { port: await listen(server), calls, upgrades };
}

test('a route reaches its own server through the app, with its path, Host, and every cookie', async () => {
	const routed = await start_routed();
	const app = await start_app({
		auth_port: await free_port(),
		routes: parse_routes([{ path: '/parties/*', port: routed.port }])
	});
	const reply = await send(app.port, '/parties/lab-yjs-sync-server/thumb-1?connectionKey=k', {
		headers: {
			host: '192.168.1.20:5173',
			cookie: 'c=1',
			[DEV_ORIGIN_HEADER]: 'https://forged.example'
		}
	});
	assert.equal(reply.status, 201);
	assert.equal(reply.body, 'routed /parties/lab-yjs-sync-server/thumb-1?connectionKey=k');
	assert.deepEqual(reply.headers['set-cookie'], ['a=1; Path=/', 'b=2; Path=/']);
	const [call] = routed.calls;
	assert.equal(call.headers.host, '192.168.1.20:5173');
	assert.equal(call.headers.cookie, 'c=1');
	assert.equal(call.headers[DEV_ORIGIN_HEADER], undefined);

	const post = await send(app.port, '/parties/x', {
		method: 'POST',
		headers: { host: app.host, origin: app.origin, 'content-type': 'text/plain' },
		body: 'hello'
	});
	assert.equal(post.status, 201);
	assert.equal(routed.calls.at(-1)?.body, 'hello');

	for (const [what, path, headers, status] of /** @type {const} */ ([
		['a foreign Origin', '/parties/x', { host: app.host, origin: 'https://evil.example' }, 403],
		['no Origin', '/parties/x', { host: app.host }, 403],
		['another host', '/parties/x', { host: 'evil.example', origin: 'http://evil.example' }, 403]
	])) {
		const refused = await send(app.port, path, { method: 'POST', headers, body: 'x' });
		assert.equal(refused.status, status, what);
	}
	for (const path of [
		'/parties/../api/auth/get-session',
		'/parties/%2e%2e/x',
		'/parties/a%2Fb',
		'/parties//x'
	]) {
		const refused = await send(app.port, path, { headers: { host: app.host } });
		assert.equal(refused.status, 400, path);
	}
	const absolute = await send(app.port, `http://127.0.0.1:${routed.port}/parties/x`, {
		headers: { host: app.host }
	});
	assert.equal(absolute.status, 400);
	assert.equal(routed.calls.length, 2);
});

test('a route whose server is down, stalled, or sent too much fails with what is wrong', async () => {
	const stalled = await start_broken(() => {});
	const routed = await start_routed();
	const limits = {
		...GATEWAY_LIMITS,
		route_answer_ms: 300,
		route_connect_ms: 200,
		route_body_bytes: 16
	};
	const app = await start_app({
		auth_port: await free_port(),
		limits,
		routes: parse_routes([
			{ path: '/down/*', port: await free_port() },
			{ path: '/stalled/*', port: stalled.port },
			{ path: '/small/*', port: routed.port }
		])
	});
	const down = await send(app.port, '/down/x', { headers: { host: app.host } });
	assert.equal(down.status, 502);
	assert.match(
		down.body,
		/^Nothing is running for \/down\/\* \(127\.0\.0\.1:\d+\)\. Start that server, then reload\.$/
	);
	const slow = await send(app.port, '/stalled/x', { headers: { host: app.host } });
	assert.equal(slow.status, 504);
	assert.match(slow.body, /within 300 ms/);
	assert.equal(stalled.state.connections, 1);
	const large = await send(app.port, '/small/x', {
		method: 'POST',
		headers: { host: app.host, origin: app.origin },
		body: 'x'.repeat(64)
	});
	assert.equal(large.status, 413);
});

/**
 * Sends a WebSocket upgrade by hand and gives the first answer, and the socket.
 * @param {number} port
 * @param {string} path
 * @param {Record<string, string>} headers
 * @returns {Promise<{ answer: string, socket: import('node:net').Socket }>}
 */
function open_upgrade(port, path, headers) {
	return new Promise((resolve, reject) => {
		const socket = connect({ host: '127.0.0.1', port });
		socket.setEncoding('utf8');
		socket.once('error', reject);
		socket.once('connect', () => {
			const lines = [
				`GET ${path} HTTP/1.1`,
				'Connection: Upgrade',
				'Upgrade: websocket',
				'Sec-WebSocket-Version: 13',
				'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
				...Object.entries(headers).map(([name, value]) => `${name}: ${value}`)
			];
			socket.write(`${lines.join('\r\n')}\r\n\r\n`);
		});
		socket.once('data', (answer) => resolve({ answer: String(answer), socket }));
	});
}

test('a WebSocket on a route connects through the app; a foreign page or host is refused', async () => {
	const routed = await start_routed();
	const app = await start_app({
		auth_port: await free_port(),
		routes: parse_routes([{ path: '/parties/*', port: routed.port }])
	});
	const open = await open_upgrade(app.port, '/parties/lab-yjs-sync-server/c1', {
		Host: app.host,
		Origin: app.origin,
		[DEV_ORIGIN_HEADER]: 'https://forged.example'
	});
	cleanups.push(() => open.socket.destroy());
	assert.match(open.answer, /^HTTP\/1\.1 101 Switching Protocols/);
	const echoed = new Promise((resolve) => open.socket.once('data', resolve));
	open.socket.write('ping');
	assert.equal(await echoed, 'ping');
	assert.match(routed.upgrades[0], new RegExp(`Host\n${app.host}`));
	assert.doesNotMatch(routed.upgrades[0], new RegExp(DEV_ORIGIN_HEADER, 'i'));

	for (const [what, path, headers] of /** @type {const} */ ([
		['a foreign Origin', '/parties/c1', { Host: app.host, Origin: 'https://evil.example' }],
		['no Origin', '/parties/c1', { Host: app.host }],
		['another host', '/parties/c1', { Host: 'evil.example', Origin: 'http://evil.example' }],
		['a path escape', '/parties/../x', { Host: app.host, Origin: app.origin }]
	])) {
		const refused = await open_upgrade(app.port, path, headers);
		cleanups.push(() => refused.socket.destroy());
		assert.match(refused.answer, /^HTTP\/1\.1 40[03] /, what);
	}
	const other = await open_upgrade(app.port, '/elsewhere', { Host: app.host, Origin: app.origin });
	cleanups.push(() => other.socket.destroy());
	assert.match(other.answer, /^HTTP\/1\.1 418 /);
	assert.equal(routed.upgrades.length, 1);
});

test("over HTTP/2 (Vite's own https server) the proxy reads :authority and forwards no pseudo-headers", async () => {
	const { createServer: create_h2c_server, connect: h2_connect } = await import('node:http2');
	const auth = await start_local_auth();
	auth.state.has_account = true;
	const routed = await start_routed();
	const gateway = create_gateway({
		routes: parse_routes([{ path: '/parties/*', port: routed.port }]),
		public_origins: [],
		allowed_hosts: () => [],
		startup_problem: () => null,
		warn: () => {},
		call_local_auth: create_local_auth_caller({ port: auth.port })
	});
	const server = create_h2c_server((request, response) =>
		gateway.handle(/** @type {never} */ (request), /** @type {never} */ (response), () =>
			response.end('app')
		)
	);
	const port = await listen(/** @type {never} */ (server));
	const session = h2_connect(`http://127.0.0.1:${port}`);
	cleanups.push(() => new Promise((resolve) => session.close(() => resolve(undefined))));
	const authority = `localhost:${port}`;

	/**
	 * @param {import('node:http2').OutgoingHttpHeaders} headers
	 * @param {string} [body]
	 * @returns {Promise<{ headers: import('node:http2').IncomingHttpHeaders, body: string }>}
	 */
	const h2_send = (headers, body) =>
		new Promise((resolve, reject) => {
			const stream = session.request({ ':authority': authority, ...headers });
			let text = '';
			/** @type {import('node:http2').IncomingHttpHeaders} */
			let answer = {};
			stream.setEncoding('utf8');
			stream.on('response', (received) => (answer = received));
			stream.on('data', (chunk) => (text += chunk));
			stream.on('end', () => resolve({ headers: answer, body: text }));
			stream.on('error', reject);
			stream.end(body);
		});

	const page = await h2_send({ ':path': '/__syntax_auth/sign-in?return_to=/a' });
	assert.equal(page.headers[':status'], 200);
	assert.match(page.body, new RegExp(`Sign in to ${authority}`));

	const signed_in = await h2_send(
		{
			':method': 'POST',
			':path': '/__syntax_auth/sign-in',
			origin: `http://${authority}`,
			'content-type': 'application/x-www-form-urlencoded'
		},
		'return_to=%2Fa'
	);
	assert.equal(signed_in.headers[':status'], 303);
	assert.equal(signed_in.headers.location, '/a');
	assert.equal(signed_in.headers['set-cookie']?.length, 2);

	const refused = await h2_send({ ':method': 'POST', ':path': '/__syntax_auth/sign-in' });
	assert.equal(refused.headers[':status'], 403);

	const routed_reply = await h2_send({ ':path': '/parties/x' });
	assert.equal(routed_reply.headers[':status'], 201);
	const [call] = routed.calls;
	assert.equal(call.headers.host, authority);
	assert.ok(Object.keys(call.headers).every((name) => !name.startsWith(':')));

	const blocked = await h2_send({
		':authority': 'evil.example',
		':path': '/__syntax_auth/sign-in'
	});
	assert.equal(blocked.headers[':status'], 403);
});

/**
 * Sends a WebSocket upgrade by hand and collects everything the proxy sends until it closes.
 * `half_open` keeps the client's own side open after the proxy ends, as a client may.
 * @param {number} port
 * @param {Record<string, string>} headers
 * @param {{ half_open?: boolean }} [options]
 */
function upgrade_until_end(port, headers, { half_open = false } = {}) {
	const socket = connect({ host: '127.0.0.1', port, allowHalfOpen: half_open });
	cleanups.push(() => socket.destroy());
	socket.setEncoding('utf8');
	socket.on('error', () => {});
	socket.once('connect', () => {
		const lines = [
			'GET /parties/c1 HTTP/1.1',
			'Connection: Upgrade',
			'Upgrade: websocket',
			'Sec-WebSocket-Version: 13',
			'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
			...Object.entries(headers).map(([name, value]) => `${name}: ${value}`)
		];
		socket.write(`${lines.join('\r\n')}\r\n\r\n`);
	});
	let received = '';
	socket.on('data', (chunk) => (received += chunk));
	/** @type {Promise<string>} once the proxy has sent its end */
	const ended = new Promise((resolve) => socket.once('end', () => resolve(received)));
	/** @type {Promise<string>} once the connection is fully closed */
	const closed = new Promise((resolve) => socket.once('close', () => resolve(received)));
	return { socket, ended, closed };
}

/** @param {() => boolean} condition @param {number} within_ms */
async function eventually(condition, within_ms) {
	const deadline = Date.now() + within_ms;
	while (!condition() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
	return condition();
}

test('a refused WebSocket upgrade is closed after its answer, even when the client keeps its side open', async () => {
	const app = await start_app({
		auth_port: await free_port(),
		limits: { ...GATEWAY_LIMITS, refusal_close_ms: 150 },
		routes: parse_routes([{ path: '/parties/*', port: await free_port() }])
	});

	// The client never ends its side: the answer still arrives whole, then the proxy closes.
	const held = upgrade_until_end(
		app.port,
		{ Host: app.host, Origin: 'https://evil.example' },
		{ half_open: true }
	);
	const answer = await held.ended;
	assert.match(answer, /^HTTP\/1\.1 403 Forbidden\r\n/);
	const [head, body] = answer.split('\r\n\r\n');
	assert.equal(Number(/content-length: (\d+)/.exec(head)?.[1]), Buffer.byteLength(body));
	const [refused] = app.upgrade_sockets;
	assert.equal(refused.destroyed, false, 'The grace period lets the answer drain first');
	assert.ok(await eventually(() => refused.destroyed, 1_000), 'The refused socket stays open');

	// A client that ends its side too is closed at once, well before the grace period.
	const slow_close = await start_app({
		auth_port: await free_port(),
		limits: { ...GATEWAY_LIMITS, refusal_close_ms: 10_000 },
		routes: parse_routes([{ path: '/parties/*', port: await free_port() }])
	});
	const started = Date.now();
	const ended = upgrade_until_end(slow_close.port, { Host: 'evil.example', Origin: app.origin });
	assert.match(await ended.closed, /^HTTP\/1\.1 403 Forbidden\r\n/);
	assert.ok(await eventually(() => slow_close.upgrade_sockets[0].destroyed, 1_000));
	assert.ok(Date.now() - started < 2_000);
});

/**
 * A raw upstream for upgrades: reads the proxied request's head, then behaves; tracks its sockets.
 * @param {(socket: import('node:net').Socket) => void} behave
 */
async function start_upgrade_upstream(behave) {
	/** @type {import('node:net').Socket[]} */
	const sockets = [];
	const server = create_net_server((socket) => {
		sockets.push(socket);
		socket.on('error', () => {});
		let head = '';
		const on_data = (/** @type {Buffer} */ chunk) => {
			head += chunk.toString('latin1');
			if (!head.includes('\r\n\r\n')) return;
			socket.removeListener('data', on_data);
			behave(socket);
		};
		socket.on('data', on_data);
	});
	cleanups.push(() => sockets.forEach((socket) => socket.destroy()));
	return { port: await listen(server), sockets };
}

const SWITCHING =
	'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=\r\n\r\n';

test('an upstream that starts but never completes a valid upgrade answer is cut off at the deadline', async () => {
	for (const scene of [
		{ what: 'one byte, then nothing', send: ['H'], expected: /^HTTP\/1\.1 504 Gateway Timeout/ },
		{
			what: 'a head that never ends',
			send: ['HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\n'],
			expected: /^HTTP\/1\.1 504 Gateway Timeout/
		},
		{
			what: 'an answer that is not an upgrade',
			send: ['HTTP/1.1 200 OK\r\ncontent-length: 2\r\n\r\nok'],
			expected: /^HTTP\/1\.1 502 Bad Gateway[^]*answered the upgrade with HTTP 200/
		},
		{
			what: 'a 101 without an Upgrade header',
			send: ['HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\n\r\n'],
			expected: /^HTTP\/1\.1 502 Bad Gateway[^]*not a valid upgrade/
		},
		{
			what: 'something other than HTTP',
			send: ['SSH-2.0-OpenSSH\r\n\r\n'],
			expected: /^HTTP\/1\.1 502 Bad Gateway[^]*not a valid upgrade/
		},
		{
			what: 'an oversized head',
			send: [`HTTP/1.1 101 Switching Protocols\r\nx-filler: ${'a'.repeat(20_000)}`],
			expected: /^HTTP\/1\.1 502 Bad Gateway[^]*larger than/
		}
	]) {
		const upstream = await start_upgrade_upstream((socket) => {
			for (const part of scene.send) socket.write(part);
		});
		const app = await start_app({
			auth_port: await free_port(),
			limits: { ...GATEWAY_LIMITS, route_answer_ms: 120, refusal_close_ms: 100 },
			routes: parse_routes([{ path: '/parties/*', port: upstream.port }])
		});
		const started = Date.now();
		const browser = upgrade_until_end(app.port, { Host: app.host, Origin: app.origin });
		const received = await browser.closed;
		assert.match(received, scene.expected, scene.what);
		assert.doesNotMatch(received, /HTTP\/1\.1 (?:101|200)|SSH|\bok$/, `${scene.what}: a leak`);
		assert.ok(Date.now() - started < 2_000, scene.what);
		assert.ok(
			await eventually(() => upstream.sockets.every((socket) => socket.destroyed), 1_000),
			`${scene.what}: upstream still open`
		);
		assert.match(app.warnings.join('\n'), /\/parties\/\* upgrade:/, scene.what);
	}
});

test('a complete upgrade answer, even split across packets, starts a tunnel that outlives every deadline', async () => {
	const upstream = await start_upgrade_upstream((socket) => {
		const split = SWITCHING.length - 10;
		socket.write(SWITCHING.slice(0, split));
		setTimeout(() => socket.write(`${SWITCHING.slice(split)}hello`), 40);
		socket.on('data', (data) => socket.write(data));
	});
	const app = await start_app({
		auth_port: await free_port(),
		limits: { ...GATEWAY_LIMITS, route_answer_ms: 120, route_idle_ms: 120 },
		routes: parse_routes([{ path: '/parties/*', port: upstream.port }])
	});
	const browser = upgrade_until_end(app.port, { Host: app.host, Origin: app.origin });
	let received = '';
	browser.socket.on('data', (chunk) => (received += chunk));
	assert.ok(await eventually(() => received.endsWith('hello'), 1_000), received);
	assert.equal(received, `${SWITCHING}hello`);

	// Quiet well past every deadline, it stays open both ways.
	await new Promise((resolve) => setTimeout(resolve, 400));
	assert.equal(browser.socket.destroyed, false);
	assert.equal(upstream.sockets[0].destroyed, false);
	browser.socket.write('ping');
	assert.ok(await eventually(() => received.endsWith('helloping'), 1_000), received);

	// Either side ending ends both.
	browser.socket.end();
	assert.ok(await eventually(() => upstream.sockets[0].destroyed, 1_000));
});

test('a browser that leaves during sign-in cancels the call, and nothing more is sent', async () => {
	/** @type {{ path: string, signal: AbortSignal | undefined }[]} */
	const calls = [];
	/** @type {(answer: import('../local_auth.js').LocalAuthAnswer) => void} */
	let answer_sign_in = () => {};
	const app = await start_app({
		auth_port: 0,
		call_local_auth: ({ path, signal }) => {
			calls.push({ path, signal });
			return new Promise((resolve) => (answer_sign_in = resolve));
		}
	});
	const browser = http_request({
		host: '127.0.0.1',
		port: app.port,
		path: '/__syntax_auth/sign-in',
		method: 'POST',
		agent: false,
		headers: {
			host: app.host,
			origin: app.origin,
			'content-type': 'application/x-www-form-urlencoded'
		}
	});
	browser.on('error', () => {});
	browser.end('return_to=%2F');
	assert.ok(await eventually(() => calls.length === 1, 1_000));
	browser.destroy();

	// The cancellation reaches the call, and the answer that arrives later starts nothing.
	assert.ok(await eventually(() => calls[0].signal?.aborted === true, 1_000));
	answer_sign_in({ status: 401, set_cookies: [], body: '{}' });
	await new Promise((resolve) => setTimeout(resolve, 100));
	assert.deepEqual(
		calls.map((call) => call.path),
		['/api/auth/sign-in/email']
	);
});

test('canceling a call to local Syntax Auth closes its connection at once, and a canceled call never connects', async () => {
	/** @type {string[]} */
	const events = [];
	const server = create_http_server((request) => {
		events.push(`request ${request.url}`);
		request.socket.once('close', () => events.push('closed'));
	});
	const port = await listen(server);
	const call = create_local_auth_caller({ port });
	const controller = new AbortController();
	const pending = call({
		method: 'POST',
		path: '/api/auth/sign-in/email',
		headers: {},
		body: '{}',
		signal: controller.signal
	});
	assert.ok(await eventually(() => events.length === 1, 1_000));
	const started = Date.now();
	controller.abort();
	const result = await pending;
	assert.ok('problem' in result);
	assert.match(result.problem, /canceled/);
	assert.ok(await eventually(() => events.includes('closed'), 1_000));
	assert.ok(Date.now() - started < 1_000);

	const never = await call({
		method: 'POST',
		path: '/api/auth/sign-up/email',
		headers: {},
		body: '{}',
		signal: AbortSignal.abort()
	});
	assert.ok('problem' in never);
	await new Promise((resolve) => setTimeout(resolve, 50));
	assert.deepEqual(events, ['request /api/auth/sign-in/email', 'closed']);
});

test('signing in passes the browser cookie on, so local Syntax Auth can see an older session cookie', async () => {
	const auth = await start_local_auth();
	auth.state.has_account = true;
	const app = await start_app({ auth_port: auth.port });
	const cookie = `__Secure-better-auth.session_token=${TOKEN}.old; theme=dark`;
	const reply = await post_form(app.port, '/__syntax_auth/sign-in', {
		host: app.host,
		origin: app.origin,
		headers: { cookie }
	});
	assert.equal(reply.status, 303);
	assert.equal(auth.calls.at(-1)?.path, '/api/auth/sign-in/email');
	assert.equal(auth.calls.at(-1)?.headers.cookie, cookie);
	assert.doesNotMatch(app.warnings.join('\n'), new RegExp(TOKEN));
});
