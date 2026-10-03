import assert from 'node:assert/strict';
import { test } from 'node:test';

import { get_oauth_valid_audiences } from './oauth_audiences';

test("tokens can be issued for Syntax Auth's own API, as before, and for Syntax Lab's MCP endpoint only", () => {
	assert.deepEqual(get_oauth_valid_audiences('https://auth.syntax.fm'), [
		'https://auth.syntax.fm/api/auth',
		'https://lab.syntax.fm/mcp'
	]);
});
