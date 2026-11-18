import assert from 'node:assert/strict';
import { test } from 'node:test';

import { get_registered_redirect_host } from './oauth_redirect';

const TASTY_CALLBACK = 'https://tasty.syntax.fm/oauth/callback/person-1';

test('the consent page names the host of a registered redirect URI', () => {
	assert.equal(get_registered_redirect_host(TASTY_CALLBACK, [TASTY_CALLBACK]), 'tasty.syntax.fm');
	// A loopback redirect registered without a port matches any port, as Better Auth allows.
	assert.equal(
		get_registered_redirect_host('http://127.0.0.1:53111/callback', [
			'http://localhost:41337/callback',
			'http://127.0.0.1/callback'
		]),
		'127.0.0.1:53111'
	);
});

test('a redirect URI on a host or scheme the client never registered names no host', () => {
	assert.equal(
		get_registered_redirect_host('https://evil.example/callback', [TASTY_CALLBACK]),
		null
	);
	assert.equal(
		get_registered_redirect_host('http://tasty.syntax.fm/oauth/callback/person-1', [
			TASTY_CALLBACK
		]),
		null
	);
	assert.equal(get_registered_redirect_host(null, [TASTY_CALLBACK]), null);
	assert.equal(get_registered_redirect_host('not a url', [TASTY_CALLBACK]), null);
	assert.equal(get_registered_redirect_host(TASTY_CALLBACK, []), null);
});
