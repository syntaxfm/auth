// Setup from start to finish on a stand-in Mac: hosts file, Caddy, certificate trust, final check.
import assert from 'node:assert/strict';
import { createServer, request as http_request } from 'node:http';
import { request as https_request } from 'node:https';
import { after, test } from 'node:test';

import { CADDY_IMAGE, TLS_POLICY_ID, route_id } from '../caddy.js';
import { BLOCK_BEGIN } from '../hosts_file.js';
import { PROBE_PATH, create_middleware } from '../plugin.js';
import { describe_result, run_setup, start_recheck } from '../setup.js';
import {
	DOCKER_GATEWAY,
	OTHER_ROOT_PEM,
	ROOT_SHA1,
	SYSTEM_HOSTS,
	create_mac,
	free_port
} from './stand_ins.js';

/** @type {(() => Promise<unknown>)[]} */
const cleanups = [];
after(() => Promise.all(cleanups.map((cleanup) => cleanup())));

/** @param {string} body @returns {Promise<number>} */
async function start_server(body) {
	const server = createServer((_, response) => response.end(body));
	await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)));
	cleanups.push(() => new Promise((resolve) => server.close(resolve)));
	return /** @type {import('node:net').AddressInfo} */ (server.address()).port;
}

/** A dev server with the plugin's middleware; it answers "app" otherwise. */
async function start_dev_server(nonce = 'nonce-1') {
	const middleware = create_middleware('lab', nonce, () => ({ state: 'running', problems: [] }));
	const server = createServer((request, response) =>
		middleware(request, response, () => response.end('app'))
	);
	await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)));
	cleanups.push(() => new Promise((resolve) => server.close(resolve)));
	return { nonce, port: /** @type {import('node:net').AddressInfo} */ (server.address()).port };
}

/**
 * A browser's request for https://<hostname><path>, through the stand-in Caddy on 127.0.0.1.
 * @param {Awaited<ReturnType<typeof create_mac>>} mac
 * @param {string} hostname
 * @param {string} path
 * @returns {Promise<{ status: number, body: string }>}
 */
function browse(mac, hostname, path = '/') {
	return new Promise((resolve, reject) => {
		const outgoing = https_request(
			{
				host: '127.0.0.1',
				port: mac.https.port,
				servername: hostname,
				path,
				headers: { host: hostname },
				rejectUnauthorized: false
			},
			(response) => {
				let body = '';
				response.on('data', (chunk) => (body += chunk));
				response.on('end', () => resolve({ status: response.statusCode ?? 0, body }));
			}
		);
		outgoing.on('error', reject);
		outgoing.end();
	});
}

/** @param {Awaited<ReturnType<typeof create_mac>>} mac @param {{ port: number, nonce: string }} dev */
async function setup_lab(mac, dev, parties_port = 0) {
	return run_setup(
		{
			name: 'lab',
			port: dev.port,
			routes: parties_port ? [{ path: '/parties/*', port: parties_port }] : [],
			nonce: dev.nonce,
			probe_path: PROBE_PATH
		},
		mac.deps
	);
}

/** @param {Awaited<ReturnType<typeof create_mac>>} mac */
function https_server(mac) {
	return /** @type {{ routes: { '@id'?: string }[] }} */ (
		mac.caddy?.config.apps?.http?.servers?.srv0
	);
}

test('a running Caddy gets the routes and policy first, keeps its other routes, and no container starts', async () => {
	const mac = await create_mac();
	cleanups.push(() => mac.close());
	const dev = await start_dev_server();
	const parties_port = await start_server('parties');

	const result = await setup_lab(mac, dev, parties_port);
	assert.equal(result.state, 'worked', JSON.stringify(result.problems));
	assert.deepEqual(describe_result({ name: 'lab' }, result, 1337), [
		'https://lab.syntax.test is ready.'
	]);

	// One password and one approval; nothing else asked, and no container.
	assert.deepEqual(
		mac.commands().filter((command) => /osascript|add-trusted|docker run/.test(command)),
		['osascript -e', 'security add-trusted-cert']
	);
	assert.ok((await mac.read_hosts()).includes(`${BLOCK_BEGIN}\n127.0.0.1 auth.syntax.test`));

	const config =
		/** @type {{ apps: { tls: { automation: { policies: { '@id': string, subjects: string[] }[] } }, pki: unknown } }} */ (
			mac.caddy?.config
		);
	assert.deepEqual(
		https_server(mac).routes.map((route) => route['@id'] ?? 'robo.online'),
		[route_id('auth'), route_id('lab'), 'robo.online']
	);
	assert.equal(config.apps.tls.automation.policies[0]['@id'], TLS_POLICY_ID);
	assert.deepEqual(config.apps.tls.automation.policies[0].subjects, [
		'auth.syntax.test',
		'lab.syntax.test',
		'syntax.test'
	]);
	assert.deepEqual(config.apps.pki, {
		certificate_authorities: { local: { install_trust: false } }
	});

	assert.deepEqual(await browse(mac, 'lab.syntax.test', '/'), { status: 200, body: 'app' });
	assert.deepEqual(await browse(mac, 'lab.syntax.test', '/parties/main/room'), {
		status: 200,
		body: 'parties'
	});
	assert.deepEqual(await browse(mac, 'robo.online'), { status: 200, body: 'robo.online' });

	// A second start asks nothing and changes nothing.
	const calls_before = mac.calls.length;
	const writes_before = mac.caddy?.writes.length;
	assert.equal((await setup_lab(mac, dev, parties_port)).state, 'worked');
	assert.deepEqual(
		mac.calls
			.slice(calls_before)
			.map((call) => `${call[0]} ${call[1]}`)
			.filter((command) => /osascript|add-trusted|delete-certificate|docker run/.test(command)),
		[]
	);
	assert.equal(mac.caddy?.writes.length, writes_before);
});

test('only this computer and the tailnet get through; any other client gets 403', async () => {
	const mac = await create_mac();
	cleanups.push(() => mac.close());
	assert.equal((await setup_lab(mac, await start_dev_server())).state, 'worked');

	for (const [client, status] of /** @type {const} */ ([
		['127.0.0.1', 200],
		['::1', 200],
		['100.101.102.103', 200],
		['192.168.1.20', 403],
		['100.128.0.1', 403],
		['8.8.8.8', 403]
	])) {
		mac.https.client = client;
		assert.equal((await browse(mac, 'lab.syntax.test')).status, status, client);
	}
});

test('the routes come back within a re-check after Caddy reloads its config', async () => {
	const mac = await create_mac();
	cleanups.push(() => mac.close());
	const dev = await start_dev_server();
	const options = {
		name: /** @type {const} */ ('lab'),
		port: dev.port,
		routes: [],
		nonce: dev.nonce,
		probe_path: PROBE_PATH
	};
	const result = await run_setup(options, mac.deps);
	assert.equal(result.state, 'worked');

	/** @type {import('../setup.js').SetupResult[]} */
	const changes = [];
	const stop = start_recheck(options, result.context, mac.deps, (change) => changes.push(change));
	cleanups.push(async () => stop());
	mac.caddy?.reload();
	assert.equal((await browse(mac, 'lab.syntax.test')).body, '');

	const deadline = Date.now() + 3_000;
	while ((await browse(mac, 'lab.syntax.test')).body !== 'app') {
		assert.ok(Date.now() < deadline, 'the routes did not come back');
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	stop();
	assert.ok(
		mac.logs.includes(
			'Caddy had lost the .syntax.test routes (it restarted or reloaded its config), so setup added them again.'
		)
	);
	assert.equal(https_server(mac).routes[2]['@id'], undefined, 'robo.online stays last');
	assert.deepEqual(changes, []);
});

test('when a second dev server takes the name, the first stops claiming it and never rewrites the route', async () => {
	const mac = await create_mac();
	cleanups.push(() => mac.close());
	const first = await start_dev_server('nonce-first');
	const options = {
		name: /** @type {const} */ ('lab'),
		port: first.port,
		routes: [],
		nonce: first.nonce,
		probe_path: PROBE_PATH
	};
	const result = await run_setup(options, mac.deps);
	assert.equal(result.state, 'worked');
	/** @type {import('../setup.js').SetupResult[]} */
	const changes = [];
	const stop = start_recheck(options, result.context, mac.deps, (change) => changes.push(change));
	cleanups.push(async () => stop());

	const second = await start_dev_server('nonce-second');
	assert.equal((await setup_lab(mac, second)).state, 'worked');
	const writes = mac.caddy?.writes.length;
	const deadline = Date.now() + 3_000;
	while (changes.length === 0) {
		assert.ok(Date.now() < deadline, 'the first dev server never noticed');
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	await new Promise((resolve) => setTimeout(resolve, 200));
	stop();
	assert.deepEqual(changes[0].problems, [
		{
			step: 'Final check',
			problem: 'https://lab.syntax.test answered HTTP 200, but not from this dev server.',
			fix: 'Another dev server may hold https://lab.syntax.test: stop it, then restart dev.'
		}
	]);
	assert.equal(mac.caddy?.writes.length, writes);
	assert.equal((await browse(mac, 'lab.syntax.test')).body, 'app');
});

test("with no Caddy running, starts Syntax's pinned container on 127.0.0.1 only", async () => {
	const mac = await create_mac({ caddy: false });
	cleanups.push(() => mac.close());
	const result = await setup_lab(mac, await start_dev_server());
	assert.equal(result.state, 'worked', JSON.stringify(result.problems));

	const docker_run = mac.calls.find((call) => call[0] === 'docker' && call[1] === 'run');
	assert.ok(docker_run);
	const published = docker_run.filter((_, i) => docker_run[i - 1] === '--publish');
	assert.deepEqual(published, [
		`127.0.0.1:${mac.deps.https_port}:443`,
		`127.0.0.1:${mac.deps.http_port}:80`,
		`127.0.0.1:${mac.deps.admin_port}:2019`
	]);
	assert.ok(docker_run.includes(CADDY_IMAGE));
	assert.ok(docker_run.includes('syntax-caddy-data:/data'));
	assert.ok(docker_run.includes('syntax-caddy-config:/config'));
	assert.match(docker_run[docker_run.length - 1], /caddy run --resume --config /);

	// Requests arrive from Docker's gateway, which the route lets through; others still get 403.
	assert.deepEqual(await browse(mac, 'lab.syntax.test'), { status: 200, body: 'app' });
	mac.https.client = '192.168.1.20';
	assert.equal((await browse(mac, 'lab.syntax.test')).status, 403);
	assert.match(JSON.stringify(mac.caddy?.config), new RegExp(`${DOCKER_GATEWAY}/32`));
});

test('port 443 held by another program: names it and starts nothing', async () => {
	const mac = await create_mac({ caddy: false });
	cleanups.push(() => mac.close());
	await mac.read_hosts();
	mac.state.listeners.set(mac.deps.https_port, [{ address: '*', process: 'nginx', pid: 4242 }]);

	const result = await setup_lab(mac, await start_dev_server());
	assert.deepEqual(result, {
		state: 'failed',
		problems: [
			{
				step: 'HTTPS proxy (Caddy)',
				problem: `Port ${mac.deps.https_port} is in use by nginx (pid 4242), so Syntax's Caddy container can't start there.`,
				fix: `Stop that program, then restart dev. If it's a Caddy, give it an admin API on localhost:${mac.deps.admin_port} and setup will add its routes there instead.`
			}
		]
	});
	assert.ok(!mac.commands().includes('docker run'));
});

test('a port 2019 listener that is not proven to be Caddy is refused and never changed', async () => {
	const imitation = await create_mac({ caddy: { imitation: true } });
	cleanups.push(() => imitation.close());
	imitation.state.listeners.set(imitation.deps.admin_port, [
		{ address: '127.0.0.1', process: 'python3', pid: 77 }
	]);
	assert.deepEqual((await setup_lab(imitation, await start_dev_server())).problems, [
		{
			step: 'HTTPS proxy (Caddy)',
			problem: `Port ${imitation.deps.admin_port} is in use by python3 (pid 77), which doesn't answer like Caddy's admin API, so setup can't add routes there or start its own Caddy.`,
			fix: 'Stop python3 (pid 77), then restart dev.'
		}
	]);
	assert.deepEqual(imitation.caddy?.writes, []);

	// Answers exactly like Caddy, but the listening process isn't caddy.
	const other = await create_mac();
	cleanups.push(() => other.close());
	other.state.listeners.set(other.deps.admin_port, [
		{ address: '127.0.0.1', process: 'node', pid: 88 }
	]);
	other.state.processes.set(88, '/usr/local/bin/node');
	assert.deepEqual((await setup_lab(other, await start_dev_server())).problems, [
		{
			step: 'HTTPS proxy (Caddy)',
			problem: `Port ${other.deps.admin_port} answers like Caddy's admin API, but it's held by node (pid 88), which is neither a caddy process nor Syntax's syntax-caddy container, so setup won't change it.`,
			fix: 'Stop node (pid 88) so setup can start its own Caddy, or run your Caddy as a caddy process, then restart dev.'
		}
	]);
	assert.deepEqual(other.caddy?.writes, []);
	assert.ok(!other.commands().includes('docker run'));
});

test('a root that did not issue the served certificate is refused, and nothing is trusted', async () => {
	const mac = await create_mac({ caddy: { root_pem: OTHER_ROOT_PEM } });
	cleanups.push(() => mac.close());
	const result = await setup_lab(mac, await start_dev_server());
	assert.deepEqual(result.problems, [
		{
			step: 'Certificate trust',
			problem:
				"Setup won't trust Caddy's root: the certificate Caddy serves for lab.syntax.test wasn't issued by the root its API gave (CN=Other Local Authority - Root).",
			fix: `Check which program serves port ${mac.deps.https_port} and Caddy's tls settings for lab.syntax.test, then restart dev.`
		}
	]);
	assert.ok(!mac.commands().includes('security add-trusted-cert'));
	assert.ok(!mac.commands().includes('security verify-cert'));
});

test('a declined certificate approval removes the certificate macOS added, and only that', async () => {
	const mac = await create_mac();
	cleanups.push(() => mac.close());
	mac.state.trust_answer = 'cancel';
	const dev = await start_dev_server();

	assert.deepEqual((await setup_lab(mac, dev)).problems, [
		{
			step: 'Certificate trust',
			problem:
				'You canceled the approval to trust Caddy\'s root ("Test Local Authority - Root"), so nothing was trusted. The certificate it had added to your login keychain was removed.',
			fix: 'Restart dev and approve the dialog (your password or Touch ID) to use https://lab.syntax.test.'
		}
	]);
	assert.deepEqual([...mac.state.keychain.certificates], []);
	assert.ok(
		mac.calls.some(
			(call) =>
				call.join(' ') === `security delete-certificate -Z ${ROOT_SHA1} ${mac.deps.keychain}`
		)
	);

	// A certificate that was already in the keychain stays there.
	mac.state.keychain.certificates.add(ROOT_SHA1);
	const result = await setup_lab(mac, dev);
	assert.match(result.problems[0].problem, /so nothing was trusted\.$/);
	assert.deepEqual([...mac.state.keychain.certificates], [ROOT_SHA1]);

	// Approving on the next start finishes setup.
	mac.state.trust_answer = 'approve';
	assert.equal((await setup_lab(mac, dev)).state, 'worked');
});

test('a declined password ends setup with its fix before anything else changes', async () => {
	const mac = await create_mac();
	cleanups.push(() => mac.close());
	mac.state.hosts_answer = 'cancel';
	assert.deepEqual((await setup_lab(mac, await start_dev_server())).problems, [
		{
			step: 'Hosts file',
			problem: `You canceled the password dialog, so ${mac.hosts_path} wasn't changed.`,
			fix: 'Restart dev and enter your password (or use Touch ID) to add the .syntax.test names.'
		}
	]);
	assert.equal(await mac.read_hosts(), SYSTEM_HOSTS);
	assert.deepEqual(mac.caddy?.writes, []);
	assert.deepEqual(
		mac.commands().filter((command) => command.startsWith('security')),
		[]
	);
});

test('without a desktop session nothing changes, and every missing step prints its fix', async () => {
	for (const scene of [
		{ desktop: 'Background', env: {} },
		{ desktop: 'Aqua', env: { SSH_CONNECTION: '1 2 3 4' } }
	]) {
		const mac = await create_mac();
		cleanups.push(() => mac.close());
		mac.state.desktop = scene.desktop;
		mac.deps.env = scene.env;
		const result = await setup_lab(mac, await start_dev_server());
		assert.equal(result.state, 'failed');
		assert.deepEqual(
			result.problems.map((problem) => problem.step),
			['Hosts file', 'HTTPS proxy (Caddy)']
		);
		assert.match(
			result.problems[0].fix,
			/^Run `pnpm exec syntax-auth-local setup lab` in Terminal at this computer's own screen \(or over Screen Sharing\), or add the lines yourself: `printf/
		);
		assert.equal(
			result.problems[1].problem,
			"Caddy is missing its local certificate authority settings, the .syntax.test certificate policy, the route for lab.syntax.test, and the route for auth.syntax.test, and setup only checks Caddy, never changes it, without a person at this computer's screen."
		);
		assert.equal(
			result.problems[1].fix,
			"Run `pnpm exec syntax-auth-local setup lab` in Terminal at this computer's own screen (or over Screen Sharing), then restart dev."
		);
		assert.equal(await mac.read_hosts(), SYSTEM_HOSTS);
		assert.deepEqual(mac.caddy?.writes, []);
		assert.deepEqual(
			mac.commands().filter((command) => /osascript|security|docker run/.test(command)),
			[]
		);
	}

	// No Caddy at all: says so, and starts nothing.
	const bare = await create_mac({ caddy: false });
	cleanups.push(() => bare.close());
	bare.state.desktop = 'Background';
	const result = await setup_lab(bare, await start_dev_server());
	assert.equal(
		result.problems[1].problem,
		`No Caddy answers on localhost:${bare.deps.admin_port}, and setup only checks, never starts one, without a person at this computer's screen.`
	);
	assert.deepEqual(
		bare.commands().filter((command) => /docker/.test(command)),
		[]
	);
});

test('on Linux and Windows nothing runs, and the macOS-only message prints', async () => {
	for (const platform of /** @type {const} */ (['linux', 'win32'])) {
		const mac = await create_mac();
		cleanups.push(() => mac.close());
		mac.deps.platform = platform;
		const result = await setup_lab(mac, await start_dev_server());
		assert.deepEqual(result, { state: 'unsupported', problems: [] });
		assert.deepEqual(mac.calls, []);
		assert.deepEqual(describe_result({ name: 'lab' }, result, 1337), [
			'Automatic setup of https://lab.syntax.test is macOS-only for now; keep using http://localhost:1337.'
		]);
	}
});

test('Docker missing when setup must start Caddy: the existing message', async () => {
	const mac = await create_mac({ caddy: false });
	cleanups.push(() => mac.close());
	mac.state.docker_installed = false;
	assert.deepEqual((await setup_lab(mac, await start_dev_server())).problems, [
		{
			step: 'HTTPS proxy (Caddy)',
			problem:
				"Docker isn't installed. Install Docker Desktop (https://www.docker.com/products/docker-desktop/) or OrbStack (https://orbstack.dev), then restart dev.",
			fix: ''
		}
	]);
});

test("a route for the app's name that setup didn't add is refused", async () => {
	const mac = await create_mac();
	cleanups.push(() => mac.close());
	const config = /** @type {{ apps: { http: { servers: { srv0: { routes: unknown[] } } } } }} */ (
		mac.caddy?.config
	);
	config.apps.http.servers.srv0.routes.push({ match: [{ host: ['*.syntax.test'] }], handle: [] });
	assert.deepEqual((await setup_lab(mac, await start_dev_server())).problems, [
		{
			step: 'HTTPS proxy (Caddy)',
			problem:
				"Caddy already has a route for lab.syntax.test that setup didn't add (routes/1 of server srv0), so setup won't take it over.",
			fix: 'Remove that route (or its site block) from your Caddy config, reload Caddy, then restart dev.'
		}
	]);
	assert.deepEqual(mac.caddy?.writes, []);
});

test("the name must reach this very dev server: a dev server Caddy can't reach fails the final check", async () => {
	const mac = await create_mac();
	cleanups.push(() => mac.close());
	const port = await free_port();
	const result = await setup_lab(mac, { port, nonce: 'nonce-2' });
	assert.deepEqual(result.problems, [
		{
			step: 'Final check',
			problem: `Caddy couldn't reach this dev server at localhost:${port}.`,
			fix: `Make sure the dev server listens on 127.0.0.1 port ${port} (if it listens on ::1 only, set \`server.host: '127.0.0.1'\` in vite.config), then restart dev.`
		}
	]);

	// Another server answering on that port isn't this one.
	const other = await start_server('someone else');
	assert.equal(
		(await setup_lab(mac, { port: other, nonce: 'nonce-3' })).problems[0].problem,
		'https://lab.syntax.test answered HTTP 200, but not from this dev server.'
	);
});

test('a probe request reaches the app only through its https name', async () => {
	const dev = await start_dev_server('nonce-4');
	const answer = await new Promise((resolve) => {
		http_request({ host: '127.0.0.1', port: dev.port, path: PROBE_PATH }, (response) => {
			let body = '';
			response.on('data', (chunk) => (body += chunk));
			response.on('end', () => resolve(body));
		}).end();
	});
	assert.equal(answer, 'app');
});
