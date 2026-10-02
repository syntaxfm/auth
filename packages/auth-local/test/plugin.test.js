// The Vite plugin: Vite's allowed hosts, the dev server's answers to page loads on other hosts, and
// the whole start on a stand-in Mac.
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { after, test } from 'node:test';

import { PROBE_PATH, USE_LOCALHOST_PATH, create_middleware, create_plugin } from '../plugin.js';
import { create_mac } from './stand_ins.js';

/** @type {(() => Promise<unknown>)[]} */
const cleanups = [];
after(() => Promise.all(cleanups.map((cleanup) => cleanup())));

const NAVIGATE = { accept: 'text/html,application/xhtml+xml', 'sec-fetch-mode': 'navigate' };
/** @type {import('../plugin.js').SiteStatus} */
const FAILED = {
	state: 'failed',
	problems: [
		{
			step: 'Certificate trust',
			problem: 'You canceled the approval <script>alert(1)</script>.',
			fix: 'Run `node packages/auth-local/bin.js setup auth`, then restart dev.'
		}
	]
};

/**
 * @param {number} port
 * @param {string} path
 * @param {Record<string, string>} headers
 * @param {string} [method]
 * @returns {Promise<{ status: number, headers: import('node:http').IncomingHttpHeaders, body: string }>}
 */
function send(port, path, headers, method = 'GET') {
	return new Promise((resolve, reject) => {
		const outgoing = request({ host: '127.0.0.1', port, path, headers, method }, (response) => {
			let body = '';
			response.on('data', (chunk) => (body += chunk));
			response.on('end', () =>
				resolve({ status: response.statusCode ?? 0, headers: response.headers, body })
			);
		});
		outgoing.on('error', reject);
		outgoing.end();
	});
}

/**
 * A dev server: its middlewares, then "app". `use` is what Vite's `server.middlewares.use` does.
 * @returns {Promise<{ port: number, use: (middleware: import('../plugin.js').Middleware) => void, server: import('node:http').Server }>}
 */
async function start_dev_server(listen = true) {
	/** @type {import('../plugin.js').Middleware[]} */
	const middlewares = [];
	const server = createServer((incoming, response) => {
		let index = 0;
		const next = () => {
			const middleware = middlewares[index++];
			if (middleware) middleware(incoming, response, next);
			else response.end('app');
		};
		next();
	});
	cleanups.push(() => new Promise((resolve) => server.close(resolve)));
	if (listen)
		await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)));
	const address = /** @type {import('node:net').AddressInfo | null} */ (server.address());
	return {
		port: address?.port ?? 0,
		use: (middleware) => void middlewares.push(middleware),
		server
	};
}

/**
 * @param {import('../plugin.js').SiteStatus} status
 * @param {import('../names.js').SiteName} [name]
 */
async function serve_with_status(status, name = 'lab') {
	const dev = await start_dev_server();
	dev.use(create_middleware(name, 'nonce-1', () => status));
	return dev.port;
}

test('after a working setup, page loads on localhost go to the https name; nothing else does', async () => {
	const port = await serve_with_status({
		state: 'worked',
		problems: [],
		context: /** @type {never} */ (null)
	});
	const host = `localhost:${port}`;

	const page = await send(port, '/compositions/7?tab=layers', { host, ...NAVIGATE });
	assert.equal(page.status, 302);
	assert.equal(page.headers.location, 'https://lab.syntax.test/compositions/7?tab=layers');
	// Without Sec-Fetch-Mode, an HTML Accept header marks a page load.
	assert.equal(
		(await send(port, '/', { host: `127.0.0.1:${port}`, accept: 'text/html' })).status,
		302
	);
	assert.equal((await send(port, '/', { host, ...NAVIGATE }, 'HEAD')).status, 302);

	for (const [headers, method] of /** @type {[Record<string, string>, string][]} */ ([
		[{ host, accept: 'text/html', 'sec-fetch-mode': 'cors' }, 'GET'],
		[{ host, accept: 'application/json' }, 'GET'],
		[{ host, ...NAVIGATE }, 'POST'],
		[{ host: 'lab.syntax.test', ...NAVIGATE }, 'GET'],
		[{ host: `192.168.1.5:${port}`, ...NAVIGATE }, 'GET'],
		[{ host: `mini.tailnet.ts.net:${port}`, ...NAVIGATE }, 'GET']
	])) {
		const answer = await send(port, '/', headers, method);
		assert.deepEqual(
			[answer.status, answer.body],
			[200, 'app'],
			JSON.stringify({ headers, method })
		);
	}

	// Syntax Auth's own dev server never redirects: apps call it on localhost.
	const auth_port = await serve_with_status(
		{ state: 'worked', problems: [], context: /** @type {never} */ (null) },
		'auth'
	);
	assert.equal(
		(await send(auth_port, '/', { host: `localhost:${auth_port}`, ...NAVIGATE })).status,
		200
	);
});

test('after a failed setup, page loads get the problem page, which can keep this browser on localhost', async () => {
	const port = await serve_with_status(FAILED);
	const host = `localhost:${port}`;

	const page = await send(port, '/compositions/7', { host, ...NAVIGATE });
	assert.equal(page.status, 503);
	assert.equal(page.headers['content-type'], 'text/html; charset=utf-8');
	assert.match(page.body, /<h1>https:\/\/lab\.syntax\.test isn&#39;t working yet<\/h1>/);
	assert.match(page.body, /<span class="label">Failed step<\/span>Certificate trust<\/h2>/);
	assert.ok(page.body.includes('You canceled the approval &lt;script&gt;alert(1)&lt;/script&gt;.'));
	assert.ok(!page.body.includes('<script>'));
	assert.ok(
		page.body.includes(
			'<strong>Fix:</strong> Run <code>node packages/auth-local/bin.js setup auth</code>, then restart dev.'
		)
	);
	const href = `${USE_LOCALHOST_PATH}?to=${encodeURIComponent('/compositions/7')}`;
	assert.ok(page.body.includes(`<a href="${href}">Use http://${host} for now</a>`));
	// Scripts' requests still reach the app.
	assert.equal((await send(port, '/api/data', { host, accept: '*/*' })).body, 'app');

	const chosen = await send(port, href, { host, ...NAVIGATE });
	assert.equal(chosen.status, 302);
	assert.equal(chosen.headers.location, '/compositions/7');
	const cookie = 'syntax_test_use_localhost_lab=1';
	assert.deepEqual(chosen.headers['set-cookie'], [`${cookie}; Path=/; HttpOnly; SameSite=Lax`]);
	assert.equal((await send(port, '/compositions/7', { host, cookie, ...NAVIGATE })).body, 'app');

	// The link only ever leads to a path on this server.
	for (const to of ['//evil.example/', 'https://evil.example/', '/\\evil.example']) {
		const answer = await send(port, `${USE_LOCALHOST_PATH}?to=${encodeURIComponent(to)}`, {
			host,
			...NAVIGATE
		});
		assert.equal(answer.headers.location, '/', to);
	}
});

test('while setup runs, page loads are served as usual; the probe answers only on the https name', async () => {
	const port = await serve_with_status({ state: 'running', problems: [] });
	assert.equal((await send(port, '/', { host: `localhost:${port}`, ...NAVIGATE })).body, 'app');
	assert.equal((await send(port, PROBE_PATH, { host: 'lab.syntax.test' })).body, 'nonce-1');
	assert.equal((await send(port, PROBE_PATH, { host: `localhost:${port}` })).body, 'app');
});

/**
 * @param {Partial<import('../plugin.js').PluginDeps>} [overrides]
 * @returns {import('../plugin.js').PluginDeps & { ensured: number }}
 */
function fake_deps(overrides = {}) {
	const deps = {
		ensured: 0,
		ensure_syntax_auth: async () => {
			deps.ensured++;
		},
		run: async () => {
			throw new Error('nothing should run');
		},
		env: {},
		platform: /** @type {NodeJS.Platform} */ ('darwin'),
		...overrides
	};
	return /** @type {import('../plugin.js').PluginDeps & { ensured: number }} */ (
		/** @type {unknown} */ (deps)
	);
}

test('the plugin never applies to builds, and under Vitest it does nothing at all', async () => {
	const deps = fake_deps({ env: { VITEST: 'true' } });
	const plugin = create_plugin({ name: 'lab' }, deps);
	assert.equal(plugin.apply, 'serve');
	assert.equal(plugin.config({}), undefined);
	let used = 0;
	plugin.configureServer({ middlewares: { use: () => used++ }, httpServer: null });
	assert.equal(used, 0);
	assert.equal(deps.ensured, 0);
});

test("Vite's allowed hosts gain .syntax.test, unless every host is already allowed", () => {
	const plugin = create_plugin({ name: 'website' }, fake_deps());
	assert.deepEqual(plugin.config({ server: { allowedHosts: ['example.test'] } }), {
		server: { allowedHosts: ['.syntax.test'] }
	});
	assert.equal(plugin.config({ server: { allowedHosts: true } }), undefined);
	// Without a name, the plugin keeps today's behavior: Syntax Auth only.
	assert.equal(create_plugin({}, fake_deps()).config({}), undefined);
});

test('a wrong option fails at config load with what is wrong', () => {
	assert.throws(
		() => create_plugin(/** @type {never} */ ({ name: 'blog' }), fake_deps()),
		/^Error: syntax_auth\(\): name must be 'auth', 'lab', or 'website', not "blog"\.$/
	);
	assert.throws(
		() => create_plugin({ name: 'lab', routes: [{ path: 'parties', port: 1999 }] }, fake_deps()),
		/each route needs a path starting with "\/" and a port number/
	);
	assert.throws(
		() => create_plugin({ name: 'lab', port: 0 }, fake_deps()),
		/port must be a port number/
	);
});

/**
 * Starts a dev server with the plugin on the stand-in Mac and waits for setup's verdict.
 * @param {Awaited<ReturnType<typeof create_mac>>} mac
 * @param {import('../plugin.js').SyntaxAuthOptions} options
 */
async function start_with_plugin(mac, options) {
	const deps = fake_deps({ ...mac.deps });
	const plugin = create_plugin(options, deps);
	const dev = await start_dev_server(false);
	plugin.configureServer({ middlewares: { use: dev.use }, httpServer: dev.server });
	await new Promise((resolve) => dev.server.listen(0, '127.0.0.1', () => resolve(undefined)));
	const port = /** @type {import('node:net').AddressInfo} */ (dev.server.address()).port;
	const deadline = Date.now() + 5_000;
	while (mac.logs.length === 0) {
		assert.ok(Date.now() < deadline, 'setup never reported');
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	return { port, deps };
}

test('a dev server start: redirects after a working setup, and the problem page after a failed one', async () => {
	const mac = await create_mac();
	cleanups.push(() => mac.close());
	const { port, deps } = await start_with_plugin(mac, { name: 'lab' });
	assert.deepEqual(mac.logs, ['https://lab.syntax.test is ready.']);
	assert.equal(deps.ensured, 1);
	const page = await send(port, '/a', { host: `localhost:${port}`, ...NAVIGATE });
	assert.equal(page.headers.location, 'https://lab.syntax.test/a');

	const declined = await create_mac();
	cleanups.push(() => declined.close());
	declined.state.hosts_answer = 'cancel';
	const failed = await start_with_plugin(declined, { name: 'lab' });
	assert.deepEqual(declined.logs, [
		[
			`https://lab.syntax.test isn't working yet, so keep using http://localhost:${failed.port} for now.`,
			`  Hosts file: You canceled the password dialog, so ${declined.hosts_path} wasn't changed. Fix: Restart dev and enter your password (or use Touch ID) to add the .syntax.test names.`
		].join('\n')
	]);
	const problem = await send(failed.port, '/a', { host: `localhost:${failed.port}`, ...NAVIGATE });
	assert.equal(problem.status, 503);
	assert.match(problem.body, /Hosts file<\/h2>/);
});

test("Syntax Auth's own dev server sets up its name but never starts the container", async () => {
	const mac = await create_mac();
	cleanups.push(() => mac.close());
	const { deps } = await start_with_plugin(mac, { name: 'auth' });
	assert.deepEqual(mac.logs, ['https://auth.syntax.test is ready.']);
	assert.equal(deps.ensured, 0);
});

test('on Linux the plugin changes nothing, prints the macOS-only message, and serves pages as usual', async () => {
	const mac = await create_mac();
	cleanups.push(() => mac.close());
	mac.deps.platform = 'linux';
	const { port } = await start_with_plugin(mac, { name: 'lab' });
	assert.deepEqual(mac.logs, [
		`Automatic setup of https://lab.syntax.test is macOS-only for now; keep using http://localhost:${port}.`
	]);
	assert.deepEqual(mac.calls, []);
	assert.equal((await send(port, '/', { host: `localhost:${port}`, ...NAVIGATE })).body, 'app');
});
