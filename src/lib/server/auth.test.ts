// Better Auth's trusted origins and cookie settings, per environment. Deployed settings are the
// production `.syntax.fm` ones, unchanged by local development's per-request settings.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { D1Database } from '@cloudflare/workers-types';

import { get_cookie_options, get_trusted_origins } from './auth';
import type { AuthEnvironment } from './env';

const DB = {} as D1Database;

const DEPLOYED: AuthEnvironment = {
	is_local_development: false,
	DB,
	BETTER_AUTH_URL: 'https://auth.syntax.fm',
	AUTH_COOKIE_DOMAIN: '.syntax.fm',
	BETTER_AUTH_SECRET: 'secret',
	GITHUB_CLIENT_ID: 'id',
	GITHUB_CLIENT_SECRET: 'secret'
};

const LOCAL: AuthEnvironment = {
	is_local_development: true,
	DB,
	BETTER_AUTH_URL: 'http://localhost:37960',
	BETTER_AUTH_SECRET: 'local'
};

test('production trusts syntax.fm and shares its cookie on .syntax.fm, as before', () => {
	assert.deepEqual(get_trusted_origins(DEPLOYED), [
		'https://syntax.fm',
		'https://*.syntax.fm',
		'https://auth.syntax.fm'
	]);
	assert.deepEqual(get_cookie_options(DEPLOYED), {
		crossSubDomainCookies: { enabled: true, domain: '.syntax.fm' }
	});
	assert.equal(get_cookie_options({ ...DEPLOYED, AUTH_COOKIE_DOMAIN: undefined }), undefined);
});

test('local mode trusts loopback apps, plus only the origin the proxy vouched for on this request', () => {
	assert.deepEqual(get_trusted_origins(LOCAL), [
		'http://localhost:37960',
		'http://localhost:*',
		'http://127.0.0.1:*'
	]);
	assert.deepEqual(
		get_trusted_origins({ ...LOCAL, trusted_dev_origin: 'https://lab.example.dev' }),
		[
			'http://localhost:37960',
			'http://localhost:*',
			'http://127.0.0.1:*',
			'https://lab.example.dev'
		]
	);
	for (const origins of [get_trusted_origins(LOCAL), get_trusted_origins(DEPLOYED)]) {
		assert.ok(!origins.some((origin) => origin.includes('syntax.test')));
	}
});

test('local cookies are host-only, and `__Secure-` only for a browser on https', () => {
	assert.deepEqual(get_cookie_options(LOCAL), { useSecureCookies: false });
	assert.deepEqual(get_cookie_options({ ...LOCAL, use_secure_cookies: true }), {
		useSecureCookies: true
	});
	// A cookie domain never reaches local mode's settings.
	assert.deepEqual(
		get_cookie_options({ ...LOCAL, AUTH_COOKIE_DOMAIN: '.syntax.test', use_secure_cookies: true }),
		{ useSecureCookies: true }
	);
});
