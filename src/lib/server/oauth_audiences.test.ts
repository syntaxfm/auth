import assert from 'node:assert/strict';
import { test } from 'node:test';

import { get_oauth_valid_audiences } from './oauth_audiences';

test("deployed Syntax Auth issues tokens for its own API and Syntax Lab's MCP endpoint only", () => {
	assert.deepEqual(get_oauth_valid_audiences('https://auth.syntax.fm', false), [
		'https://auth.syntax.fm/api/auth',
		'https://lab.syntax.fm/mcp'
	]);
});

test("local Syntax Auth also issues tokens for Lab's local MCP endpoint", () => {
	assert.deepEqual(get_oauth_valid_audiences('http://localhost:37960', true), [
		'http://localhost:37960/api/auth',
		'https://lab.syntax.fm/mcp',
		'http://localhost:1337/mcp'
	]);
});
