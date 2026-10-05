import assert from 'node:assert/strict';
import { test } from 'node:test';

import { refuse_cross_site_form } from './cross_site_forms';

const ORIGIN = 'https://auth.syntax.fm';

function form_post(path: string, headers: Record<string, string> = {}, method = 'POST') {
	const url = new URL(path, ORIGIN);
	const request = new Request(url, {
		method,
		headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
		body: 'grant_type=authorization_code'
	});
	return refuse_cross_site_form(request);
}

test('a native client may post forms to the token and revocation endpoints with no Origin', () => {
	assert.equal(form_post('/api/auth/oauth2/token'), null);
	assert.equal(form_post('/api/auth/oauth2/revoke'), null);
	assert.equal(form_post('/api/auth/oauth2/token', { origin: 'https://evil.example' }), null);
});

test('every other path still refuses a form post from another site or with no Origin, as SvelteKit did', async () => {
	for (const [path, headers] of [
		['/api/auth/oauth2/token/', {}],
		['/api/auth/oauth2/token/__data.json', {}],
		['/api/auth/oauth2/%74oken', {}],
		['/api/auth/oauth2/consent', {}],
		['/api/auth/sign-out', { origin: 'https://evil.example' }],
		['/consent', { origin: 'null' }]
	] as const) {
		const refusal = form_post(path, headers);
		assert.equal(refusal?.status, 403, path);
		assert.equal(await refusal?.text(), 'Cross-site POST form submissions are forbidden');
	}

	for (const content_type of [
		'multipart/form-data; boundary=x',
		'TEXT/PLAIN',
		'application/x-sveltekit-formdata'
	]) {
		assert.equal(
			form_post('/consent', { 'content-type': content_type })?.status,
			403,
			content_type
		);
	}

	const json_refusal = form_post('/consent', { accept: 'application/json' }, 'DELETE');
	assert.equal(json_refusal?.status, 403);
	assert.deepEqual(await json_refusal?.json(), {
		message: 'Cross-site DELETE form submissions are forbidden'
	});
});

test('same-site form posts, other content types, and GETs go on', () => {
	assert.equal(form_post('/api/auth/sign-out', { origin: ORIGIN }), null);
	assert.equal(form_post('/consent', { 'content-type': 'application/json' }), null);

	assert.equal(refuse_cross_site_form(new Request(new URL('/consent', ORIGIN))), null);
});
