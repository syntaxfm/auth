// What local Syntax Auth reads from a request to pick its cookies and trusted origin.
// src/hooks.server.test.ts covers the same rules end to end through a running local Syntax Auth.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { D1Database } from '@cloudflare/workers-types';

import { DEV_ORIGIN_HEADER, for_request, parse_dev_origin, read_local_request } from './dev_proxy';
import type { AuthEnvironment } from './env';

const DB = {} as D1Database;

const LOCAL: AuthEnvironment = {
	is_local_development: true,
	DB,
	BETTER_AUTH_URL: 'http://localhost:37960',
	BETTER_AUTH_SECRET: 'local'
};

const DEPLOYED: AuthEnvironment = {
	is_local_development: false,
	DB,
	BETTER_AUTH_URL: 'https://auth.syntax.fm',
	AUTH_COOKIE_DOMAIN: '.syntax.fm',
	BETTER_AUTH_SECRET: 'secret',
	GITHUB_CLIENT_ID: 'id',
	GITHUB_CLIENT_SECRET: 'secret'
};

function local_request(headers: Record<string, string>) {
	return new Request('http://localhost:37960/api/auth/sign-in/email', { method: 'POST', headers });
}

test('the development origin must be a bare http or https origin, as browsers write it', () => {
	for (const origin of [
		'http://localhost:5173',
		'http://192.168.1.20:5173',
		'http://[fd7a:115c:a1e0::1]:5173',
		'https://lab.example.dev',
		'https://box.tail1234.ts.net:8443'
	]) {
		assert.equal(parse_dev_origin(origin), origin);
	}
	for (const value of [
		'',
		'null',
		'lab.example.dev',
		'https://lab.example.dev/',
		'https://lab.example.dev/path',
		'https://lab.example.dev?x',
		'https://u:p@lab.example.dev',
		'https://LAB.example.dev',
		'https://lab.example.dev:443',
		'ftp://lab.example.dev',
		'javascript:alert(1)',
		'https://lab.example.dev, https://evil.example',
		`https://${'a'.repeat(2_048)}.dev`
	]) {
		assert.equal(parse_dev_origin(value), null, value);
	}
});

test("a direct call's cookie kind comes from its cookie name", () => {
	const context = (cookie?: string) => {
		const read = read_local_request(local_request(cookie ? { cookie } : {}));
		assert.ok('context' in read);
		return read.context;
	};

	assert.deepEqual(context(), { dev_origin: null, use_secure_cookies: false });
	assert.deepEqual(context('better-auth.session_token=a.b'), {
		dev_origin: null,
		use_secure_cookies: false
	});
	assert.deepEqual(context('theme=dark; __Secure-better-auth.session_token=a.b'), {
		dev_origin: null,
		use_secure_cookies: true
	});
	assert.deepEqual(context('x__Secure-better-auth.session_token=a.b'), {
		dev_origin: null,
		use_secure_cookies: false
	});
});

test("the proxy's origin picks the scheme's cookie, and must match the request's Origin", async () => {
	for (const [origin, use_secure_cookies] of [
		['http://192.168.1.20:5173', false],
		['https://lab.example.dev', true]
	] as const) {
		const read = read_local_request(local_request({ origin, [DEV_ORIGIN_HEADER]: origin }));
		assert.deepEqual(read, { context: { dev_origin: origin, use_secure_cookies } });
		// get-session has no Origin; the scheme still decides, whatever the cookie.
		const get = read_local_request(
			local_request({ [DEV_ORIGIN_HEADER]: origin, cookie: '__Secure-better-auth.session_token=a' })
		);
		assert.deepEqual(get, { context: { dev_origin: origin, use_secure_cookies } });
	}

	for (const [headers, status] of [
		[{ [DEV_ORIGIN_HEADER]: '' }, 400],
		[{ [DEV_ORIGIN_HEADER]: 'https://lab.example.dev/' }, 400],
		[{ [DEV_ORIGIN_HEADER]: 'https://u:p@lab.example.dev' }, 400],
		[{ [DEV_ORIGIN_HEADER]: 'https://*.example.dev' }, 400],
		[{ [DEV_ORIGIN_HEADER]: 'https://*' }, 400],
		[{ [DEV_ORIGIN_HEADER]: 'http://?.example.dev' }, 400],
		[{ [DEV_ORIGIN_HEADER]: 'https://lab.example.dev', origin: 'https://evil.example' }, 403],
		[{ [DEV_ORIGIN_HEADER]: 'https://evil.example', origin: 'http://localhost:5173' }, 403],
		[{ [DEV_ORIGIN_HEADER]: 'https://lab.example.dev', origin: 'null' }, 403]
	] as const) {
		const read = read_local_request(local_request(headers));
		assert.ok('refusal' in read, JSON.stringify(headers));
		assert.equal(read.refusal.status, status, JSON.stringify(headers));
		assert.match(
			await read.refusal.text(),
			/^Local Syntax Auth refused a request whose x-syntax-auth-dev-origin header/
		);
	}
});

test('local mode takes the per-request settings; deployed Syntax Auth ignores the header entirely', () => {
	const headers = {
		origin: 'https://lab.example.dev',
		[DEV_ORIGIN_HEADER]: 'https://lab.example.dev',
		cookie: '__Secure-better-auth.session_token=a'
	};
	assert.deepEqual(for_request(LOCAL, local_request(headers)), {
		environment: {
			...LOCAL,
			trusted_dev_origin: 'https://lab.example.dev',
			use_secure_cookies: true
		}
	});
	assert.deepEqual(for_request(LOCAL, local_request({})), {
		environment: { ...LOCAL, trusted_dev_origin: undefined, use_secure_cookies: false }
	});

	for (const forged of [headers, { [DEV_ORIGIN_HEADER]: 'not an origin' }]) {
		const read = for_request(DEPLOYED, local_request(forged));
		assert.ok('environment' in read);
		assert.equal(read.environment, DEPLOYED);
	}
});
