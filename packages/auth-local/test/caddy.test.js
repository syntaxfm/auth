// Caddy's browser-origin rules apply to real HTTP requests, not a mocked fetch response.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';

import { caddy_api, find_caddy, probe_caddy_api } from '../caddy.js';
import { create_mac, start_fake_caddy } from './stand_ins.js';

test('the Caddy stand-in rejects fetch without an Origin, and rejects origins outside its list', async (t) => {
	const caddy = await start_fake_caddy({
		config: { admin: { origins: ['localhost:2019'] } }
	});
	t.after(() => caddy.close());

	const missing = await fetch(`${caddy.origin}/config/`);
	assert.equal(missing.status, 403);
	assert.deepEqual(await missing.json(), {
		error: "client is not allowed to access from origin ''"
	});
	const wrong = await fetch(`${caddy.origin}/config/`, {
		headers: { Origin: 'http://another.example' }
	});
	assert.equal(wrong.status, 403);
	assert.deepEqual(await wrong.json(), {
		error: "client is not allowed to access from origin 'http://another.example'"
	});
	const allowed = await fetch(`${caddy.origin}/config/`, {
		headers: { Origin: 'http://localhost:2019' }
	});
	assert.equal(allowed.status, 200);
});

test('every Caddy API method works without browser headers, with explicit origins or default settings', async (t) => {
	for (const admin of [{ origins: ['localhost:2019'] }, { listen: '0.0.0.0:2019' }]) {
		const caddy = await start_fake_caddy({ config: { admin, apps: {} } });
		t.after(() => caddy.close());
		const deps = { admin_origin: caddy.origin };
		assert.deepEqual(await probe_caddy_api(deps), { kind: 'caddy' });
		assert.equal((await caddy_api(deps, 'GET', '/pki/ca/local')).status, 200);

		// A multibyte payload also checks Content-Length counts bytes, not characters.
		const first = { label: 'Certificat de développement' };
		assert.equal((await caddy_api(deps, 'PUT', '/config/apps/example', first)).status, 200);
		assert.deepEqual((await caddy_api(deps, 'GET', '/config/apps/example')).json, first);
		assert.equal(
			(await caddy_api(deps, 'PATCH', '/config/apps/example', { label: 'updated' })).status,
			200
		);
		assert.equal(
			(await caddy_api(deps, 'POST', '/config/apps/example', { label: 'posted' })).status,
			200
		);
		assert.equal((await caddy_api(deps, 'DELETE', '/config/apps/example')).status, 200);
		for (const { headers } of caddy.requests) {
			assert.equal(headers.origin, undefined);
			assert.ok(!Object.keys(headers).some((name) => name.startsWith('sec-fetch-')));
		}
	}
});

test(
	'an interrupted Caddy response resolves as no answer instead of waiting or throwing',
	{ timeout: 2_000 },
	async (t) => {
		const server = createServer((_, response) => {
			response.writeHead(200, { 'content-type': 'application/json' });
			response.write('{');
			setImmediate(() => response.destroy());
		});
		await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)));
		t.after(() => new Promise((resolve) => server.close(resolve)));
		const port = /** @type {import('node:net').AddressInfo} */ (server.address()).port;
		const answer = await caddy_api({ admin_origin: `http://127.0.0.1:${port}` }, 'GET', '/config/');
		assert.equal(answer.status, 0);
		assert.equal(answer.json, null);
		assert.match(answer.text, /aborted|socket hang up/);
	}
);

test('a Caddy response that never finishes is stopped at the API deadline', async (t) => {
	/** @type {() => void} */
	let received = () => {};
	const headers_received = new Promise((resolve) => {
		received = () => resolve(undefined);
	});
	const server = createServer((_, response) => {
		response.writeHead(200, { 'content-type': 'application/json' });
		response.write('{');
		received();
	});
	await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)));
	t.after(() => {
		server.closeAllConnections();
		return new Promise((resolve) => server.close(resolve));
	});
	t.mock.timers.enable({ apis: ['setTimeout'] });
	const port = /** @type {import('node:net').AddressInfo} */ (server.address()).port;
	const pending = caddy_api({ admin_origin: `http://127.0.0.1:${port}` }, 'GET', '/config/');
	await headers_received;
	t.mock.timers.tick(10_000);
	assert.deepEqual(await pending, { status: 0, json: null, text: 'no answer within 10 seconds' });
});

test('an existing API refusal names its status and error instead of claiming Caddy never answered', async (t) => {
	const mac = await create_mac({ caddy: { config: { admin: { enforce_origin: true } } } });
	t.after(() => mac.close());
	const result = await find_caddy(mac.deps, { can_change: true });
	assert.deepEqual(result, {
		problem: `Port ${mac.deps.admin_port} is in use by caddy (pid 610), which answered setup's request for Caddy's config with 403 "client is not allowed to access from origin ''", so setup can't add routes there or start its own Caddy.`,
		fix: `Caddy refused it as a request from a browser or from an origin it doesn't allow (its admin \`origins\` or \`enforce_origin\` setting). If it's your Caddy, let requests from this computer reach its admin API on localhost:${mac.deps.admin_port}; otherwise stop caddy (pid 610). Then restart dev.`
	});
	assert.deepEqual(mac.caddy?.writes, []);
	assert.ok(!mac.commands().includes('docker run'));
});

test('a newly started container that answers with an error reports the refusal immediately', async (t) => {
	const mac = await create_mac({ caddy: false });
	t.after(() => mac.close());
	const server = createServer((_, response) => {
		response.writeHead(503, { 'content-type': 'application/json' });
		response.end(JSON.stringify({ error: 'config storage unavailable' }));
	});
	t.after(() => new Promise((resolve) => server.close(resolve)));
	mac.state.docker_run = async () => {
		await new Promise((resolve) =>
			server.listen(mac.deps.admin_port, '127.0.0.1', () => resolve(undefined))
		);
		return { code: 0, stdout: 'container-id', stderr: '' };
	};
	const started = Date.now();
	const result = await find_caddy(mac.deps, { can_change: true });
	assert.deepEqual(result, {
		problem: `Syntax's Caddy container started, and its admin API on localhost:${mac.deps.admin_port} answered, but refused setup's request with 503 "config storage unavailable".`,
		fix: 'Check `docker logs syntax-caddy` for the reason, then restart dev.'
	});
	assert.ok(
		Date.now() - started < 2_000,
		'an explicit refusal should not wait for the startup deadline'
	);
});

test('an origin refusal from Syntax Caddy names the saved-config repair without discarding routes or certificates', async (t) => {
	const mac = await create_mac({ caddy: false });
	t.after(() => mac.close());
	mac.state.docker_run = async () => {
		const caddy = await start_fake_caddy({
			port: mac.deps.admin_port,
			config: { admin: { enforce_origin: true } }
		});
		t.after(() => caddy.close());
		return { code: 0, stdout: 'container-id', stderr: '' };
	};
	assert.deepEqual(await find_caddy(mac.deps, { can_change: true }), {
		problem: `Syntax's Caddy container started, and its admin API on localhost:${mac.deps.admin_port} answered, but refused setup's request with 403 "client is not allowed to access from origin ''".`,
		fix: `Caddy refused it as a request from a browser or from an origin it doesn't allow (its admin \`origins\` or \`enforce_origin\` setting). Correct Syntax Caddy's saved admin settings in \`/config/caddy/autosave.json\` inside syntax-caddy: set \`admin.enforce_origin\` to false and \`admin.origins\` to ${JSON.stringify([`localhost:${mac.deps.admin_port}`, `127.0.0.1:${mac.deps.admin_port}`])}. Keep every other setting, route, and certificate volume. Run \`docker restart syntax-caddy\`, then restart dev. Removing only the container won't reset its saved settings.`
	});
});

test('a newly started container that never answers reports the bounded wait and its fix', async (t) => {
	const mac = await create_mac({ caddy: false });
	t.after(() => mac.close());
	mac.state.docker_run = async () => ({ code: 0, stdout: 'container-id', stderr: '' });
	assert.deepEqual(
		await find_caddy({ ...mac.deps, api_start_timeout_ms: 50 }, { can_change: true }),
		{
			problem: `Syntax's Caddy container started, but its admin API didn't answer on localhost:${mac.deps.admin_port} within 0.05 seconds.`,
			fix: 'Check `docker logs syntax-caddy` for the reason, then restart dev.'
		}
	);
});
