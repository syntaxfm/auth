// Edge cases of host and cookie matching. src/hooks.server.test.ts covers the same rules end to end
// through a running local Syntax Auth.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { get_local_site, is_syntax_test_app_url } from './local_hosts';

test('a loopback request is a .syntax.test request only with the exact secure session cookie', () => {
	const site = (cookie_header: string | null) => get_local_site('localhost', cookie_header);

	assert.equal(site(null), 'loopback');
	assert.equal(site('better-auth.session_token=a.b'), 'loopback');
	assert.equal(site('x__Secure-better-auth.session_token=a.b'), 'loopback');
	assert.equal(site('__Secure-better-auth.session_token_old=a.b'), 'loopback');
	assert.equal(site('theme=__Secure-better-auth.session_token'), 'loopback');
	assert.equal(site('theme=dark;__Secure-better-auth.session_token=a.b'), 'syntax_test');
	assert.equal(
		site('better-auth.session_token=a.b; __Secure-better-auth.session_token=c.d'),
		'syntax_test'
	);
	assert.equal(get_local_site('[::1]', '__Secure-better-auth.session_token=a.b'), 'syntax_test');
	assert.equal(get_local_site('127.0.0.1', null), 'loopback');
});

test('only auth.syntax.test and loopback names are local sites, whatever the cookie', () => {
	const cookie = '__Secure-better-auth.session_token=a.b';

	assert.equal(get_local_site('auth.syntax.test', null), 'syntax_test');
	assert.equal(get_local_site('auth.syntax.test.', cookie), null);
	assert.equal(get_local_site('syntax.test', cookie), null);
	assert.equal(get_local_site('lab.syntax.test', cookie), null);
	assert.equal(get_local_site('auth.syntax.test.example.com', cookie), null);
	assert.equal(get_local_site('localhost.example.com', cookie), null);
});

test('app URLs must be https on syntax.test or a subdomain, with no credentials', () => {
	const accepts = (url: string) => is_syntax_test_app_url(new URL(url));

	assert.equal(accepts('https://lab.syntax.test:8443/x?y=1'), true);
	assert.equal(accepts('https://a.b.syntax.test/'), true);
	assert.equal(accepts('https://evilsyntax.test/'), false);
	assert.equal(accepts('https://u@lab.syntax.test/'), false);
	assert.equal(accepts('https://:p@syntax.test/'), false);
	assert.equal(accepts('wss://lab.syntax.test/'), false);
});
