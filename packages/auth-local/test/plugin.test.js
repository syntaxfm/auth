// The Vite plugin: its options, Vite's allowed hosts, what a dev server start does (and never does),
// and the proxy it mounts.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { ensure_syntax_auth } from '../index.js';
import { create_plugin } from '../plugin.js';

/** @type {(() => Promise<unknown>)[]} */
const cleanups = [];
after(() => Promise.all(cleanups.map((cleanup) => cleanup())));

/** @param {string} stdout */
const ok = (stdout = '') => ({ code: 0, stdout, stderr: '' });
/** @param {string} stderr */
const fail = (stderr) => ({ code: 1, stdout: '', stderr });

/**
 * @param {Partial<import('../plugin.js').PluginDeps>} [overrides]
 */
function fake_deps(overrides = {}) {
	const deps = {
		env: /** @type {NodeJS.ProcessEnv} */ ({}),
		/** @type {{ env: NodeJS.ProcessEnv }[]} */
		ensured: [],
		/** @type {string[]} */
		warnings: [],
		/** @type {import('../plugin.js').PluginDeps['ensure_syntax_auth']} */
		ensure_syntax_auth: async (options) => void deps.ensured.push({ env: options.env }),
		/** @type {import('../local_auth.js').CallLocalAuth} */
		call_local_auth: async () => ({ status: 200, set_cookies: [], body: 'null' }),
		/** @param {string} message */
		warn: (message) => void deps.warnings.push(message),
		...overrides
	};
	return deps;
}

/**
 * A stand-in Vite dev server: its middlewares in front of "app", and its upgrade listeners.
 * @param {{ allowedHosts?: string[] | true }} [server_config]
 */
async function start_dev_server(server_config = {}) {
	/** @type {import('../plugin.js').Middleware[]} */
	const middlewares = [];
	/** @type {unknown[]} */
	const upgrade_listeners = [];
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
	await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)));
	const port = /** @type {import('node:net').AddressInfo} */ (server.address()).port;
	/** @type {import('../plugin.js').DevServer} */
	const dev_server = {
		middlewares: { use: (middleware) => void middlewares.push(middleware) },
		httpServer: {
			on: (_event, listener) => {
				upgrade_listeners.push(listener);
				return server.on('upgrade', listener);
			}
		},
		config: { server: server_config }
	};
	return { port, dev_server, middlewares, upgrade_listeners };
}

/**
 * @param {number} port
 * @param {string} path
 * @param {Record<string, string>} headers
 * @returns {Promise<{ status: number, headers: import('node:http').IncomingHttpHeaders, body: string }>}
 */
function send(port, path, headers) {
	return new Promise((resolve, reject) => {
		const outgoing = request(
			{ host: '127.0.0.1', port, path, headers, agent: false },
			(response) => {
				let body = '';
				response.on('data', (chunk) => (body += chunk));
				response.on('end', () =>
					resolve({ status: response.statusCode ?? 0, headers: response.headers, body })
				);
			}
		);
		outgoing.on('error', reject);
		outgoing.end();
	});
}

const NAVIGATE = { accept: 'text/html,application/xhtml+xml', 'sec-fetch-mode': 'navigate' };

test('the plugin never applies to builds, and under Vitest it does nothing at all', async () => {
	for (const value of ['true', '', 'false']) {
		const deps = fake_deps({
			env: { VITEST: value, SYNTAX_AUTH_PUBLIC_ORIGINS: 'https://lab.example.dev' }
		});
		const plugin = create_plugin({ routes: [{ path: '/parties/*', port: 1348 }] }, deps);
		assert.equal(plugin.apply, 'serve');
		assert.equal(plugin.config({}), undefined);
		const dev = await start_dev_server();
		plugin.configureServer(dev.dev_server);
		assert.equal(dev.middlewares.length, 0);
		assert.equal(dev.upgrade_listeners.length, 0);
		assert.deepEqual(deps.ensured, []);
	}
});

test("Vite's allowed hosts gain only the public origins' names, from the option or the variable", () => {
	assert.equal(create_plugin({}, fake_deps()).config({}), undefined);
	const plugin = create_plugin(
		{ public_origins: ['https://lab.example.dev'] },
		fake_deps({ env: { SYNTAX_AUTH_PUBLIC_ORIGINS: 'http://box.tail1234.ts.net:5173' } })
	);
	assert.deepEqual(plugin.config({ server: { allowedHosts: ['example.test'] } }), {
		server: { allowedHosts: ['lab.example.dev', 'box.tail1234.ts.net'] }
	});
	// Never `true`, and nothing added where the app already allows every host.
	assert.equal(plugin.config({ server: { allowedHosts: true } }), undefined);
});

test('a wrong option fails at config load with what is wrong', () => {
	const deps = fake_deps();
	assert.throws(
		() => create_plugin(/** @type {never} */ ('lab'), deps),
		/options must be an object/
	);
	assert.throws(
		() => create_plugin(/** @type {never} */ ({ publicOrigins: [] }), deps),
		/^Error: syntax_auth\(\): unknown option "publicOrigins"; it takes routes and public_origins\.$/
	);
	assert.throws(
		() => create_plugin({ routes: [{ path: 'parties', port: 1999 }] }, deps),
		/each route needs a path like '\/parties\/\*'/
	);
	assert.throws(
		() => create_plugin({ routes: [{ path: '/api/auth/*', port: 37960 }] }, deps),
		/can't send paths to local Syntax Auth's port 37960/
	);
	assert.throws(
		() => create_plugin({ public_origins: ['https://lab.example.dev/x'] }, deps),
		/needs origins like/
	);
	assert.throws(
		() => create_plugin({}, fake_deps({ env: { SYNTAX_AUTH_PUBLIC_ORIGINS: 'lab.example.dev' } })),
		/^Error: SYNTAX_AUTH_PUBLIC_ORIGINS needs origins like/
	);
});

test('legacy name and port options change nothing outside the dev server and never redirect', async () => {
	for (const options of [{ name: 'lab', port: 1337 }, { name: 'auth' }, { name: 'website' }, {}]) {
		const deps = fake_deps();
		const plugin = create_plugin(options, deps);
		assert.equal(plugin.config({}), undefined, JSON.stringify(options));
		const dev = await start_dev_server();
		plugin.configureServer(dev.dev_server);
		assert.equal(dev.middlewares.length, 1);
		assert.deepEqual(deps.ensured, [{ env: {} }]);

		for (const host of [`localhost:${dev.port}`, `127.0.0.1:${dev.port}`, `[::1]:${dev.port}`]) {
			const page = await send(dev.port, '/a', { host, ...NAVIGATE });
			assert.equal(page.status, 200, host);
			assert.equal(page.body, 'app', host);
			assert.equal(page.headers.location, undefined, host);
		}
		const sign_in = await send(dev.port, '/__syntax_auth/sign-in', {
			host: `localhost:${dev.port}`,
			...NAVIGATE
		});
		assert.equal(sign_in.status, 200);
		assert.match(sign_in.body, /Continue as Local Developer/);
	}
});

test("the sign-in page names local Syntax Auth's startup problem when it can't reach it", async () => {
	const deps = fake_deps({
		ensure_syntax_auth: async ({ warn }) => warn("Running signed out: Docker isn't running."),
		call_local_auth: async () => ({
			problem: "Local Syntax Auth isn't running at http://localhost:37960 (connection refused)."
		})
	});
	const plugin = create_plugin({}, deps);
	const dev = await start_dev_server();
	plugin.configureServer(dev.dev_server);
	await new Promise((resolve) => setImmediate(resolve));
	assert.deepEqual(deps.warnings, ["Running signed out: Docker isn't running."]);
	const page = await send(dev.port, '/__syntax_auth/sign-in?return_to=/x', {
		host: `localhost:${dev.port}`
	});
	assert.equal(page.status, 503);
	assert.match(page.body, /isn&#39;t running at http:\/\/localhost:37960 \(connection refused\)/);
	assert.match(
		page.body,
		/When this dev server started: Running signed out: Docker isn&#39;t running\./
	);
	assert.match(page.body, /href="\/__syntax_auth\/sign-in\?return_to=%2Fx">Try again</);
});

test("the proxy answers only Vite's allowed hosts and the public origins' names", async () => {
	const plugin = create_plugin({ public_origins: ['https://lab.example.dev'] }, fake_deps());
	const dev = await start_dev_server({ allowedHosts: ['.home.arpa'] });
	plugin.configureServer(dev.dev_server);
	for (const host of ['nas.home.arpa:5173', 'lab.example.dev', '192.168.1.20:5173']) {
		assert.equal((await send(dev.port, '/__syntax_auth/sign-in', { host })).status, 200, host);
	}
	assert.equal(
		(await send(dev.port, '/__syntax_auth/sign-in', { host: 'evil.example' })).status,
		403
	);

	// `allowedHosts: true` turns off Vite's check, never the proxy's.
	const open = await start_dev_server({ allowedHosts: true });
	create_plugin({}, fake_deps()).configureServer(open.dev_server);
	assert.equal(
		(await send(open.port, '/__syntax_auth/sign-in', { host: 'evil.example' })).status,
		403
	);
});

test('routes listen for WebSocket upgrades on the dev server, and say so when there is none', async () => {
	const with_routes = await start_dev_server();
	create_plugin({ routes: [{ path: '/parties/*', port: 1348 }] }, fake_deps()).configureServer(
		with_routes.dev_server
	);
	assert.equal(with_routes.upgrade_listeners.length, 1);

	const without = await start_dev_server();
	create_plugin({}, fake_deps()).configureServer(without.dev_server);
	assert.equal(without.upgrade_listeners.length, 0);

	const deps = fake_deps();
	/** @type {unknown[]} */
	const used = [];
	create_plugin({ routes: [{ path: '/parties/*', port: 1348 }] }, deps).configureServer({
		middlewares: { use: (middleware) => void used.push(middleware) },
		httpServer: null
	});
	assert.equal(used.length, 1);
	assert.deepEqual(deps.warnings, [
		'This dev server has no HTTP server of its own (middleware mode), so WebSocket upgrades on routes are not proxied.'
	]);
});

/**
 * The real ensure_syntax_auth with only commands, the health check, the updater, and the lock as
 * stand-ins.
 * @param {import('../container.js').Run} run
 * @param {() => boolean} healthy
 * @param {NodeJS.Platform} platform
 * @param {string} directory
 */
function real_ensure(run, healthy, platform, directory) {
	const auth = { checks: 0, updaters: 0, /** @type {string[]} */ logs: [] };
	/** @type {import('../plugin.js').PluginDeps['ensure_syntax_auth']} */
	const ensure = (options) =>
		ensure_syntax_auth({
			env: options.env,
			run,
			container_lock: (task) => task(),
			docker_start: {
				platform,
				result_path: join(directory, 'docker-start.json'),
				ready_timeout_ms: 300,
				poll_ms: 10
			},
			is_healthy: async () => {
				auth.checks++;
				return healthy();
			},
			start_updater: () => void auth.updaters++,
			warn: (message) => {
				auth.logs.push(message);
				options.warn(message);
			}
		});
	return { auth, ensure };
}

/** @param {{ updaters: number, logs: string[] }} auth */
async function wait_for_start(auth) {
	const deadline = Date.now() + 5_000;
	while (auth.updaters === 0 && auth.logs.length === 0) {
		assert.ok(Date.now() < deadline, "local Syntax Auth's start never finished");
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}

/**
 * Docker whose engine runs (or not), where Syntax Auth's image is present and its container
 * missing; records every command.
 * @param {{ running: boolean }} scene
 */
function recording_docker({ running }) {
	/** @type {string[]} */
	const calls = [];
	let started = false;
	/** @type {import('../container.js').Run} */
	const run = async (command, args) => {
		calls.push(`${command} ${args.join(' ')}`);
		if (command === 'launchctl') return ok('Aqua');
		if (command !== 'docker') return fail(`unexpected ${command}`);
		if (args[0] === 'info')
			return running ? ok('29.5.3') : fail('Cannot connect to the Docker daemon');
		if (args[0] === 'image') return ok();
		if (args[0] === 'container') return fail('Error: No such container: syntax-auth');
		if (args[0] === 'run') {
			started = true;
			return ok('container-id');
		}
		return fail(`unexpected docker ${args[0]}`);
	};
	return { run, calls, is_started: () => started };
}

test('a start on macOS or Linux, from any shell, starts the container when Docker runs, and only Docker', async () => {
	const directory = await mkdtemp(join(tmpdir(), 'syntax-auth-plugin-'));
	cleanups.push(() => rm(directory, { recursive: true, force: true }));
	for (const [platform, env] of /** @type {const} */ ([
		['linux', {}],
		['darwin', {}],
		['darwin', { PI_CODING_AGENT: 'true' }],
		['linux', { SSH_CONNECTION: '100.64.0.2 50000 100.64.0.1 22' }]
	])) {
		const docker = recording_docker({ running: true });
		const { auth, ensure } = real_ensure(docker.run, docker.is_started, platform, directory);
		const plugin = create_plugin(
			{ name: 'lab', port: 1337 },
			fake_deps({ env, ensure_syntax_auth: ensure })
		);
		const dev = await start_dev_server();
		plugin.configureServer(dev.dev_server);
		await wait_for_start(auth);
		const label = `${platform} ${JSON.stringify(env)}`;
		assert.deepEqual(auth.logs, [], label);
		assert.equal(auth.updaters, 1, label);
		assert.deepEqual(
			docker.calls,
			[
				'docker info --format {{.ServerVersion}}',
				'docker image inspect ghcr.io/syntaxfm/auth-local:latest',
				'docker container inspect --format {{.State.Running}} {{.Image}} syntax-auth',
				'docker run --detach --init --name syntax-auth --restart unless-stopped --publish 127.0.0.1:37960:37960 --volume syntax-auth:/app/.wrangler ghcr.io/syntaxfm/auth-local:latest'
			],
			label
		);
	}
});

test("from an agent shell, over SSH, or under a test runner, a start whose Docker isn't running never opens the Docker app", async () => {
	const directory = await mkdtemp(join(tmpdir(), 'syntax-auth-plugin-'));
	cleanups.push(() => rm(directory, { recursive: true, force: true }));
	for (const [env, where] of /** @type {const} */ ([
		[{ PI_CODING_AGENT: 'true' }, 'from an agent shell (PI_CODING_AGENT)'],
		[{ SSH_TTY: '/dev/ttys004' }, 'over SSH (SSH_TTY is set)'],
		[{ NODE_TEST_CONTEXT: 'child-v8' }, 'under a test runner (NODE_TEST_CONTEXT is set)']
	])) {
		const docker = recording_docker({ running: false });
		const { auth, ensure } = real_ensure(docker.run, docker.is_started, 'darwin', directory);
		const deps = fake_deps({ env, ensure_syntax_auth: ensure });
		create_plugin({ name: 'lab' }, deps).configureServer((await start_dev_server()).dev_server);
		await wait_for_start(auth);
		const message = `Running signed out: Docker isn't running, and this dev server was started ${where}, so it didn't open Docker Desktop or OrbStack. Start Docker Desktop (or OrbStack), then restart dev.`;
		assert.deepEqual(auth.logs, [message]);
		assert.deepEqual(deps.warnings, [message]);
		assert.deepEqual(
			docker.calls.filter((call) => !/^docker info|^launchctl/.test(call)),
			[],
			JSON.stringify(env)
		);
	}
});

test("a dev server's start of local Syntax Auth puts a time limit on every command it runs", async () => {
	const directory = await mkdtemp(join(tmpdir(), 'syntax-auth-plugin-'));
	cleanups.push(() => rm(directory, { recursive: true, force: true }));
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
		/** @type {{ command: string, timeout_ms?: number, kill_grace_ms?: number }[]} */
		const recorded = [];
		let started = false;
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
			if (first === 'pull')
				return scene.denied && !options.env ? fail('Error: denied: denied') : ok();
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
		const { auth, ensure } = real_ensure(run, () => started, 'linux', directory);
		create_plugin({}, fake_deps({ ensure_syntax_auth: ensure })).configureServer(
			(await start_dev_server()).dev_server
		);
		await wait_for_start(auth);

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
		const commands = recorded.map((call) => call.command);
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
