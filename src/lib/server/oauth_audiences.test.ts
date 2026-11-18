import assert from 'node:assert/strict';
import { test } from 'node:test';

import { get_oauth_valid_audiences } from './oauth_audiences';

test("deployed Syntax Auth issues tokens for its own API and Lab's and the website's MCP endpoints only", () => {
	assert.deepEqual(get_oauth_valid_audiences('https://auth.syntax.fm', false), [
		'https://auth.syntax.fm/api/auth',
		'https://lab.syntax.fm/mcp',
		'https://beta.syntax.fm/mcp',
		'https://syntax.fm/mcp'
	]);
});

test("local Syntax Auth also issues tokens for Lab's and the website's local MCP endpoints", () => {
	assert.deepEqual(get_oauth_valid_audiences('http://localhost:37960', true), [
		'http://localhost:37960/api/auth',
		'https://lab.syntax.fm/mcp',
		'https://beta.syntax.fm/mcp',
		'https://syntax.fm/mcp',
		'http://localhost:1337/mcp',
		'http://localhost:5740/mcp'
	]);
});
