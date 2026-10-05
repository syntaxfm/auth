// Edge cases of host and cookie matching. src/hooks.server.test.ts covers the same rules end to end
// through a running local Syntax Auth.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
	get_host_header_hostname,
	has_cookie,
	is_local_hostname,
	is_syntax_test_app_url,
	local_host_refusal,
	name_refused_origin
} from './local_hosts';

test('a cookie is found only by its exact name', () => {
	const name = '__Secure-better-auth.session_token';

	assert.equal(has_cookie(null, name), false);
	assert.equal(has_cookie('better-auth.session_token=a.b', name), false);
	assert.equal(has_cookie('x__Secure-better-auth.session_token=a.b', name), false);
	assert.equal(has_cookie('__Secure-better-auth.session_token_old=a.b', name), false);
	assert.equal(has_cookie('theme=__Secure-better-auth.session_token', name), false);
	assert.equal(has_cookie('theme=dark;__Secure-better-auth.session_token=a.b', name), true);
	assert.equal(
		has_cookie('better-auth.session_token=a.b; __Secure-better-auth.session_token=c', name),
		true
	);
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

test('Host headers resolve to the hostname SvelteKit sees, and only loopback names pass', () => {
	const passes = (host: string | undefined) => is_local_hostname(get_host_header_hostname(host));

	assert.equal(get_host_header_hostname('LOCALHOST:37960'), 'localhost');
	assert.equal(get_host_header_hostname('[::1]:37960'), '[::1]');
	assert.equal(get_host_header_hostname(undefined), '');
	assert.equal(get_host_header_hostname('a b'), 'a b');
	assert.equal(passes('localhost'), true);
	assert.equal(passes('127.0.0.1:37960'), true);
	assert.equal(passes('[::1]'), true);
	for (const host of [
		undefined,
		'auth.syntax.test',
		'lab.syntax.test',
		'evil.localhost:37960',
		'10.0.0.1',
		'192.168.1.20:37960',
		'100.101.102.103',
		'localhost@evil.example',
		'localhost.example.com'
	]) {
		assert.equal(passes(host), false, String(host));
	}
	assert.equal(
		local_host_refusal('lab.example.dev', 'http://localhost:37960'),
		'Local Syntax Auth answers only localhost, 127.0.0.1, and [::1], so it refused this request for "lab.example.dev". Open http://localhost:37960 instead, or sign in through your app\'s own /__syntax_auth/sign-in.'
	);
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
		sign_out_request({ origin: 'https://lab.example.dev' }),
		true
	);

	assert.equal(reply.status, 403);
	assert.equal(reply.headers.get('x-kept'), 'yes');
	assert.deepEqual(await reply.json(), {
		code: 'INVALID_ORIGIN',
		message:
			'Local Syntax Auth refused a request from origin "https://lab.example.dev": it accepts only http://localhost:<port> and http://127.0.0.1:<port>. Apps on any other address sign in and out through their own /__syntax_auth/ paths (@syntaxfm/auth-local).'
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
