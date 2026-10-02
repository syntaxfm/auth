// Edge cases of host and cookie matching. src/hooks.server.test.ts covers the same rules end to end
// through a running local Syntax Auth.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
	get_host_header_hostname,
	get_local_site,
	is_local_hostname,
	is_syntax_test_app_url,
	name_refused_origin
} from './local_hosts';

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

test('Host headers resolve to the hostname SvelteKit sees, and only local names pass', () => {
	const passes = (host: string | undefined) => is_local_hostname(get_host_header_hostname(host));

	assert.equal(get_host_header_hostname('AUTH.Syntax.Test:443'), 'auth.syntax.test');
	assert.equal(get_host_header_hostname('[::1]:37960'), '[::1]');
	assert.equal(get_host_header_hostname(undefined), '');
	assert.equal(get_host_header_hostname('a b'), 'a b');
	assert.equal(passes('localhost'), true);
	assert.equal(passes('127.0.0.1:37960'), true);
	assert.equal(passes('[::1]'), true);
	assert.equal(passes('auth.syntax.test'), true);
	assert.equal(passes(undefined), false);
	assert.equal(passes('evil.localhost:37960'), false);
	assert.equal(passes('10.0.0.1'), false);
	assert.equal(passes('localhost@evil.example'), false);
	assert.equal(passes('auth.syntax.test.'), false);
});

const INVALID_ORIGIN_BODY = { message: 'Invalid origin', code: 'INVALID_ORIGIN' };

function better_auth_reply(body: unknown, status = 403) {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json', 'x-kept': 'yes' }
	});
}

function sign_out_request(headers: Record<string, string>) {
	return new Request('http://localhost:37960/api/auth/sign-out', { method: 'POST', headers });
}

test('locally, a refused origin is named with the addresses local Syntax Auth accepts', async () => {
	const reply = await name_refused_origin(
		better_auth_reply(INVALID_ORIGIN_BODY),
		sign_out_request({ origin: 'https://syntax.test.example' }),
		true
	);

	assert.equal(reply.status, 403);
	assert.equal(reply.headers.get('x-kept'), 'yes');
	assert.deepEqual(await reply.json(), {
		code: 'INVALID_ORIGIN',
		message:
			'Local Syntax Auth refused a request from origin "https://syntax.test.example": it accepts only http://localhost:<port>, http://127.0.0.1:<port>, https://syntax.test, and https://*.syntax.test. Open the app at one of those addresses.'
	});

	// Better Auth falls back to Referer when there's no Origin.
	const by_referer = await name_refused_origin(
		better_auth_reply(INVALID_ORIGIN_BODY),
		sign_out_request({ referer: 'https://evil.example/page' }),
		true
	);
	assert.match((await by_referer.json()).message, /from origin "https:\/\/evil\.example\/page"/);
});

test('deployed refusals and other responses pass through unchanged', async () => {
	const request = sign_out_request({ origin: 'https://evil.example' });

	for (const [response, is_local] of [
		[better_auth_reply(INVALID_ORIGIN_BODY), false],
		[better_auth_reply({ message: 'Invalid callbackURL', code: 'INVALID_CALLBACK_URL' }), true],
		[better_auth_reply(INVALID_ORIGIN_BODY, 400), true],
		[new Response('Forbidden', { status: 403 }), true]
	] as const) {
		assert.equal(await name_refused_origin(response, request, is_local), response);
	}
});
