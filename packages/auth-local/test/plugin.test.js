// The Vite plugin: Vite's allowed hosts, the dev server's answers to page loads on other hosts, and
// the whole start on a stand-in Mac.
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { after, test } from 'node:test';

import { ensure_syntax_auth } from '../index.js';
import {
	PROBE_PATH,
	USE_LOCALHOST_PATH,
	create_middleware,
	create_plugin,
	safe_destination
} from '../plugin.js';
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
	for (const to of [
		'//evil.example/',
		'https://evil.example/',
		'/\\evil.example',
		'/\t/evil.example/'
	]) {
		const answer = await send(port, `${USE_LOCALHOST_PATH}?to=${encodeURIComponent(to)}`, {
			host,
			...NAVIGATE
		});
		assert.equal(answer.headers.location, '/', to);
	}
});

test('the "use localhost" link never leaves this origin, whatever a browser would strip or rewrite', async () => {
	const host = 'localhost:5173';
	const bypasses = [
		'/\t/evil.example/',
		'/\n/evil.example/',
		'/\r\n/evil.example/',
		'\t//evil.example/',
		'/\u0000/evil.example/',
		'/\x7f/evil.example/',
		'/\\evil.example/',
		'\\/evil.example/',
		'/\\/evil.example/',
		'\\\\evil.example/',
		'//evil.example/',
		'///evil.example/',
		' //evil.example/',
		'/ /evil.example/',
		'https://evil.example/',
		'https:evil.example',
		'javascript:alert(1)',
		'%2F%2Fevil.example/',
		'%2F%5Cevil.example/',
		'',
		null
	];
	for (const to of bypasses) {
		assert.equal(safe_destination(to, host), '/', JSON.stringify(to));
	}
	// Through the dev server, encoded once (as the link does) and twice.
	const port = await serve_with_status(FAILED);
	for (const to of bypasses.filter((item) => item !== null)) {
		for (const query of [encodeURIComponent(to), encodeURIComponent(encodeURIComponent(to))]) {
			const answer = await send(port, `${USE_LOCALHOST_PATH}?to=${query}`, {
				host: `localhost:${port}`,
				...NAVIGATE
			});
			const location = String(answer.headers.location);
			assert.equal(
				new URL(location, `http://localhost:${port}`).origin,
				`http://localhost:${port}`,
				`${JSON.stringify(to)} -> ${location}`
			);
			assert.ok(location.startsWith('/') && !/^\/[/\\]/.test(location), location);
		}
	}

	// Paths on this server keep their query and fragment, normalized as a browser would.
	assert.equal(
		safe_destination('/compositions/7?tab=layers#top', host),
		'/compositions/7?tab=layers#top'
	);
	assert.equal(safe_destination('/a/../b', host), '/b');
	assert.equal(safe_destination('/%2F/evil.example/', host), '/%2F/evil.example/');
	assert.equal(safe_destination('/%09/evil.example/', host), '/%09/evil.example/');
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
		/each route needs a path starting with "\/" \(without spaces, quotes, or backslashes\) and a port number/
	);
	assert.throws(
		() => create_plugin({ name: 'lab', port: 0 }, fake_deps()),
		/port must be a port number/
	);
});

/**
 * The real ensure_syntax_auth on the stand-in Mac: its commands run through `mac.run` (or `run`),
 * so a start of Docker or the container shows in `mac.calls`. Only the health check, the updater,
 * and the container lock (on a free port) are stand-ins.
 * @param {Awaited<ReturnType<typeof create_mac>>} mac
 * @param {boolean | (() => boolean)} healthy whether local Syntax Auth answers
 * @param {import('../container.js').Run} [run]
 */
function real_ensure(mac, healthy, run = mac.run) {
	const auth = { checks: 0, updaters: 0, /** @type {string[]} */ logs: [] };
	/** @param {{ can_start?: boolean }} [options] */
	const ensure = (options) =>
		ensure_syntax_auth({
			...options,
			run,
			container_lock: mac.deps.container_lock,
			docker_start: mac.docker_start,
			is_healthy: async () => {
				auth.checks++;
				return typeof healthy === 'function' ? healthy() : healthy;
			},
			start_updater: () => void auth.updaters++,
			warn: (message) => void auth.logs.push(message)
		});
	return { auth, ensure };
}

/**
 * Starts a dev server with the plugin on the stand-in Mac and waits for setup's verdict.
 * @param {Awaited<ReturnType<typeof create_mac>>} mac
 * @param {import('../plugin.js').SyntaxAuthOptions} options
 * @param {{ healthy?: boolean | (() => boolean), run?: import('../container.js').Run }} [scene]
 */
async function start_with_plugin(mac, options, { healthy = true, run } = {}) {
	const { auth, ensure } = real_ensure(mac, healthy, run);
	const deps = fake_deps({ ...mac.deps, ensure_syntax_auth: ensure });
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
	while (options.name !== 'auth' && auth.checks === 0) {
		assert.ok(Date.now() < deadline, 'local Syntax Auth was never checked');
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	await new Promise((resolve) => setTimeout(resolve, 50));
	return { port, deps, auth };
}

test('a dev server start: redirects after a working setup, and the problem page after a failed one', async () => {
	const mac = await create_mac();
	cleanups.push(() => mac.close());
	const { port, auth } = await start_with_plugin(mac, { name: 'lab' });
	assert.deepEqual(mac.logs, ['https://lab.syntax.test is ready.']);
	assert.deepEqual(auth, { checks: 1, updaters: 1, logs: [] });
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
	const { auth } = await start_with_plugin(mac, { name: 'auth' });
	assert.deepEqual(mac.logs, ['https://auth.syntax.test is ready.']);
	assert.deepEqual(auth, { checks: 0, updaters: 0, logs: [] });
});

test('on Linux the plugin changes nothing, prints the macOS-only message, and serves pages as usual', async () => {
	const mac = await create_mac();
	cleanups.push(() => mac.close());
	mac.deps.platform = 'linux';
	const { port, auth } = await start_with_plugin(mac, { name: 'lab' }, { healthy: false });
	assert.deepEqual(mac.logs, [
		`Automatic setup of https://lab.syntax.test is macOS-only for now; keep using http://localhost:${port}.`
	]);
	// Local Syntax Auth too is only checked: no Docker, no container, and the command to start it.
	assert.deepEqual(mac.calls, []);
	assert.deepEqual(auth, { checks: 1, updaters: 0, logs: [SIGNED_OUT] });
	assert.equal((await send(port, '/', { host: `localhost:${port}`, ...NAVIGATE })).body, 'app');
});

const SIGNED_OUT =
	"Running signed out: local Syntax Auth isn't running, and this dev server starts it only on a Mac with a person at its screen. Run `pnpm exec syntax-auth-local` to start it, then restart dev.";

test('over SSH, or with nobody at the screen, a site never starts Docker or the container', async () => {
	for (const scene of [
		{ desktop: 'Aqua', env: { SSH_CONNECTION: '100.64.0.2 50000 100.64.0.1 22' } },
		{ desktop: 'Background', env: {} }
	]) {
		const mac = await create_mac();
		cleanups.push(() => mac.close());
		mac.state.desktop = scene.desktop;
		mac.deps.env = scene.env;
		const { auth } = await start_with_plugin(mac, { name: 'lab' }, { healthy: false });
		assert.deepEqual(auth, { checks: 1, updaters: 0, logs: [SIGNED_OUT] });
		assert.deepEqual(
			// Setup itself only reads (`docker container inspect`); nothing starts or downloads.
			mac.commands().filter((command) => /^docker (info|image|pull|run|start)|^open/.test(command)),
			[]
		);
	}
});

test('from an agent shell, a dev start shows no dialog and says why first, yet still keeps local Syntax Auth running', async () => {
	const mac = await create_mac();
	cleanups.push(() => mac.close());
	mac.deps.env = { PI_CODING_AGENT: 'true' };
	const { port, auth } = await start_with_plugin(mac, { name: 'lab' });
	const [first, second] = mac.logs[0].split('\n');
	assert.equal(
		first,
		"Started from an agent shell (PI_CODING_AGENT), so setup didn't show any dialogs and changed nothing. A person at this Mac can run each fix below in their own Terminal, or restart dev with SYNTAX_DEV_SETUP_DIALOGS=allow while watching the screen."
	);
	assert.equal(
		second,
		`  https://lab.syntax.test isn't working yet, so keep using http://localhost:${port} for now.`
	);
	assert.deepEqual(
		mac
			.commands()
			.filter((command) => /^(osascript|sudo) |^security add|^security delete/.test(command)),
		[]
	);
	// Opening Docker and starting the container show none of setup's dialogs, so a site may still
	// start them (the updater starts only when it may).
	assert.deepEqual(auth, { checks: 1, updaters: 1, logs: [] });
});

test("without a name the plugin keeps today's behavior on any platform: it starts local Syntax Auth", async () => {
	const mac = await create_mac();
	cleanups.push(() => mac.close());
	mac.deps.platform = 'linux';
	const { auth, ensure } = real_ensure(mac, true);
	/** @type {unknown[]} */
	const received = [];
	const plugin = create_plugin(
		{},
		fake_deps({
			...mac.deps,
			ensure_syntax_auth: (options) => {
				received.push(options);
				return ensure(options);
			}
		})
	);
	let used = 0;
	plugin.configureServer({ middlewares: { use: () => used++ }, httpServer: null });
	await new Promise((resolve) => setTimeout(resolve, 50));
	assert.deepEqual(received, [undefined]);
	assert.deepEqual(auth, { checks: 1, updaters: 1, logs: [] });
	assert.equal(used, 0);
	assert.deepEqual(mac.calls, []);
});

/** @param {string} stdout */
const ok = (stdout = '') => ({ code: 0, stdout, stderr: '' });
/** @param {string} stderr */
const fail = (stderr) => ({ code: 1, stdout: '', stderr });

test("a site's start of local Syntax Auth puts a time limit on every command it runs", async () => {
	const scenes = [
		{ name: 'download, then create', image: false, denied: false, container: false },
		{ name: 'start the stopped container', image: true, denied: false, container: true },
		{
			name: 'download as a Syntax team member through gh',
			image: false,
			denied: true,
			container: false
		}
	];
	for (const scene of scenes) {
		const mac = await create_mac();
		cleanups.push(() => mac.close());
		/** @type {{ command: string, timeout_ms?: number, kill_grace_ms?: number }[]} */
		const recorded = [];
		let started = false;
		/** Local Syntax Auth's commands, recorded; setup's own commands still go to `mac.run`. */
		/** @type {import('../container.js').Run} */
		const run = async (command, args, options = {}) => {
			recorded.push({
				command: `${command} ${args.slice(0, 2).join(' ')}`,
				timeout_ms: options.timeout_ms,
				kill_grace_ms: options.kill_grace_ms
			});
			const [first, second] = args;
			if (command === 'gh') {
				if (second === 'user') return ok('scott');
				if (second?.startsWith('user/memberships')) return ok('active');
				return ok('gho_token');
			}
			if (command !== 'docker')
				return { code: null, stdout: '', stderr: `spawn ${command} ENOENT` };
			if (first === 'info') return ok('29.5.3');
			if (first === 'context') return ok('unix:///var/run/docker.sock');
			if (first === 'login') return ok('Login Succeeded');
			if (first === 'image') return scene.image ? ok() : fail('Error: No such image');
			if (first === 'pull') {
				return scene.denied && !options.env ? fail('Error: denied: denied') : ok();
			}
			if (first === 'container') {
				return scene.container
					? ok('false sha256:old')
					: fail('Error: No such container: syntax-auth');
			}
			if (first === 'run' || first === 'start') {
				started = true;
				return ok('container-id');
			}
			return fail(`docker ${first} is not set up`);
		};
		const { auth } = await start_with_plugin(mac, { name: 'lab' }, { healthy: () => started, run });
		const deadline = Date.now() + 5_000;
		while (auth.updaters === 0 && auth.logs.length === 0) {
			assert.ok(Date.now() < deadline, `${scene.name}: local Syntax Auth's start never finished`);
			await new Promise((resolve) => setTimeout(resolve, 20));
		}

		const commands = recorded.map((call) => call.command);
		const expected = {
			'download, then create': [
				'docker info --format',
				'docker image inspect',
				'docker pull --quiet',
				'docker container inspect',
				'docker run --detach'
			],
			'start the stopped container': [
				'docker info --format',
				'docker image inspect',
				'docker container inspect',
				'docker start syntax-auth'
			],
			// Then `docker login` and the pull, when this computer has a docker binary on its PATH.
			'download as a Syntax team member through gh': [
				'docker info --format',
				'docker image inspect',
				'docker pull --quiet',
				'gh api user',
				'gh api user/memberships/orgs/syntaxfm',
				'gh auth token',
				'docker context inspect'
			]
		}[scene.name];
		assert.deepEqual(commands.slice(0, expected?.length), expected, scene.name);
		for (const call of recorded) {
			const limit = /^docker pull/.test(call.command)
				? 600_000
				: /^docker (run|start)/.test(call.command)
					? 120_000
					: 30_000;
			assert.deepEqual(
				{ command: call.command, timeout_ms: call.timeout_ms, kill_grace_ms: call.kill_grace_ms },
				{ command: call.command, timeout_ms: limit, kill_grace_ms: 2_000 },
				scene.name
			);
		}
	}
});
