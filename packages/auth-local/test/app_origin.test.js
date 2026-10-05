// The development proxy's request rules: hosts, origins, return paths, and routes.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
	accepted_origins,
	canonical_origin,
	check_origin,
	find_route,
	is_allowed_host,
	is_clean_path,
	parse_routes,
	read_public_origins,
	safe_return_path,
	split_target
} from '../app_origin.js';

test("the proxy answers Vite's hosts only: IPs, localhost names, and allowed or public names", () => {
	const allowed = ['lab.example.dev', '.tail1234.ts.net'];
	for (const host of [
		'localhost:5173',
		'localhost',
		'app.localhost:5173',
		'127.0.0.1:5173',
		'192.168.1.20:5173',
		'100.101.102.103:5173',
		'[::1]:5173',
		'[fe80::1]',
		'[fd7a:115c:a1e0::1]:5173',
		'lab.example.dev',
		'LAB.Example.dev:8443',
		'box.tail1234.ts.net:5173',
		'tail1234.ts.net'
	]) {
		assert.equal(is_allowed_host(host, allowed), true, host);
	}
	for (const host of [
		undefined,
		'',
		'evil.example',
		'evil.example:5173',
		'lab.example.dev.evil.example',
		'xlab.example.dev',
		'tail1234.ts.net.evil',
		'localhost.evil.example',
		'user@localhost:5173',
		'localhost:5173/path',
		'localhost:5173?x',
		'local host',
		'localhost\\evil',
		'localhost:99999',
		'[not-ipv6]',
		'lab-yjs-sync-worker.internal'
	]) {
		assert.equal(is_allowed_host(host, allowed), false, String(host));
	}
});

test("a request's own origin comes from the connection, plus configured public origins on the same host", () => {
	const public_origins = ['https://lab.example.dev', 'https://box.tail1234.ts.net:8443'];
	assert.deepEqual(accepted_origins('192.168.1.20:5173', { encrypted: false, public_origins }), [
		'http://192.168.1.20:5173'
	]);
	assert.deepEqual(accepted_origins('lab.example.dev', { encrypted: false, public_origins }), [
		'http://lab.example.dev',
		'https://lab.example.dev'
	]);
	// A proxy that names the default port still means the same origin.
	assert.deepEqual(accepted_origins('lab.example.dev:443', { encrypted: false, public_origins }), [
		'http://lab.example.dev:443',
		'https://lab.example.dev'
	]);
	assert.deepEqual(
		accepted_origins('box.tail1234.ts.net:8443', { encrypted: false, public_origins }),
		['http://box.tail1234.ts.net:8443', 'https://box.tail1234.ts.net:8443']
	);
	assert.deepEqual(accepted_origins('[::1]:5173', { encrypted: true, public_origins: [] }), [
		'https://[::1]:5173'
	]);
});

test('state-changing requests need an Origin this address accepts, and a same-origin fetch site', () => {
	const accepted = ['http://localhost:5173'];
	assert.deepEqual(check_origin({ origin: 'http://localhost:5173' }, accepted), {
		origin: 'http://localhost:5173'
	});
	assert.deepEqual(
		check_origin({ origin: 'http://localhost:5173', 'sec-fetch-site': 'same-origin' }, accepted),
		{ origin: 'http://localhost:5173' }
	);
	for (const headers of [
		{},
		{ origin: 'null' },
		{ origin: 'http://evil.example' },
		{ origin: 'http://localhost:5174' },
		{ origin: 'https://localhost:5173' },
		{ origin: 'http://user:pass@localhost:5173' },
		{ origin: 'http://localhost:5173, http://evil.example' },
		{ origin: 'http://localhost:5173', 'sec-fetch-site': 'cross-site' },
		{ origin: 'http://localhost:5173', 'sec-fetch-site': 'same-site' }
	]) {
		assert.ok('problem' in check_origin(headers, accepted), JSON.stringify(headers));
	}
	const https = check_origin({ origin: 'https://lab.example.dev' }, ['http://lab.example.dev']);
	assert.ok('problem' in https);
	assert.match(https.problem, /add that origin to SYNTAX_AUTH_PUBLIC_ORIGINS/);
});

test('a return path stays a path on this app; anything else becomes "/"', () => {
	for (const [value, expected] of [
		['/compositions/1?tab=a#b', '/compositions/1?tab=a#b'],
		['/', '/'],
		['/a/../b', '/b'],
		['/%2F%2Fevil.example', '/%2F%2Fevil.example']
	]) {
		assert.equal(safe_return_path(value), expected, value);
	}
	for (const value of [
		null,
		undefined,
		'',
		'https://evil.example/',
		'http://localhost:5173/',
		'//evil.example/',
		'/\\evil.example',
		'\\\\evil.example',
		'/\t/evil.example',
		'/\n/evil.example',
		'/./\u0000',
		'/.//evil.example',
		'/..//evil.example',
		'javascript:alert(1)',
		'evil.example',
		'/__syntax_auth/sign-in',
		'/__syntax_auth',
		`/${'a'.repeat(2_048)}`
	]) {
		assert.equal(safe_return_path(value), '/', JSON.stringify(value));
	}
});

test('public origins must be bare http or https origins, from the option or the variable', () => {
	assert.deepEqual(
		read_public_origins(['https://Lab.Example.dev/'], {
			SYNTAX_AUTH_PUBLIC_ORIGINS: 'http://box.tail1234.ts.net:5173, https://lab.example.dev'
		}),
		['https://lab.example.dev', 'http://box.tail1234.ts.net:5173']
	);
	assert.deepEqual(read_public_origins(undefined, {}), []);
	for (const value of [
		'lab.example.dev',
		'ftp://lab.example.dev',
		'https://user:pass@lab.example.dev',
		'https://lab.example.dev/path',
		'https://lab.example.dev?x=1',
		'https://lab.example.dev#x',
		'https://*.example.dev'
	]) {
		assert.equal(canonical_origin(value), null, value);
		assert.throws(() => read_public_origins([value], {}), /needs origins like/, value);
		assert.throws(
			() => read_public_origins(undefined, { SYNTAX_AUTH_PUBLIC_ORIGINS: value }),
			/^Error: SYNTAX_AUTH_PUBLIC_ORIGINS needs origins like/,
			value
		);
	}
	assert.throws(() => read_public_origins('https://lab.example.dev', {}), /must be an array/);
});

test('routes are exact paths or /prefix/* on another local port, never Syntax Auth or the proxy', () => {
	assert.deepEqual(
		parse_routes([
			{ path: '/parties/*', port: 1348 },
			{ path: '/health', port: 1349 }
		]),
		[
			{ path: '/parties/*', port: 1348, prefix: '/parties/' },
			{ path: '/health', port: 1349, prefix: null }
		]
	);
	for (const route of [
		{ path: 'parties/*', port: 1348 },
		{ path: '/*', port: 1348 },
		{ path: '/parties/../*', port: 1348 },
		{ path: '/./x', port: 1348 },
		{ path: '/a//b', port: 1348 },
		{ path: '/a%2fb', port: 1348 },
		{ path: '/a b', port: 1348 },
		{ path: "/a'b", port: 1348 },
		{ path: '/__syntax_auth/*', port: 1348 },
		{ path: '/__syntax_auth', port: 1348 },
		{ path: '/parties/*', port: 0 },
		{ path: '/parties/*', port: 65_536 },
		{ path: '/parties/*', port: '1348' },
		{ path: '/parties/*', port: 37960 },
		null
	]) {
		assert.throws(() => parse_routes([route]), /^Error: syntax_auth\(\): /, JSON.stringify(route));
	}
	assert.throws(() => parse_routes({ path: '/x', port: 1 }), /must be an array/);
});

test('only an origin-form target matches a route, and a routed path must stay inside it', () => {
	const routes = parse_routes([{ path: '/parties/*', port: 1348 }]);
	assert.deepEqual(split_target('/parties/a?x=1'), { path: '/parties/a', query: '?x=1' });
	for (const target of [
		'http://127.0.0.1:37960/api/auth/get-session',
		'//evil.example/x',
		'*',
		''
	]) {
		assert.equal(split_target(target), null, target);
	}
	assert.equal(find_route('/parties/lab/a', routes)?.port, 1348);
	assert.equal(find_route('/parties', routes), null);
	assert.equal(find_route('/partiesx/a', routes), null);
	assert.equal(find_route('/PARTIES/a', routes), null);
	assert.equal(is_clean_path('/parties/lab-yjs-sync-server/thumb-1'), true);
	for (const path of [
		'/parties/../api/auth/get-session',
		'/parties/./x',
		'/parties/..',
		'/parties/%2e%2e/x',
		'/parties/%2E./x',
		'/parties/a%2fb',
		'/parties/a%5Cb',
		'/parties/a\\b',
		'/parties//x',
		'/parties/a\u0000'
	]) {
		assert.equal(is_clean_path(path), false, path);
	}
});
