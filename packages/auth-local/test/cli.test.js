// The `syntax-auth-local setup` command line.
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import { USAGE, parse_setup_args } from '../cli.js';
import { run } from '../container.js';

const BIN = fileURLToPath(new URL('../bin.js', import.meta.url));

test('setup reads the name, the port, and path routes in either flag form', () => {
	assert.deepEqual(
		parse_setup_args([
			'lab',
			'--port',
			'1337',
			'--route',
			'/parties/*=1348',
			'--route=/api/*=8787'
		]),
		{
			options: {
				name: 'lab',
				port: 1337,
				routes: [
					{ path: '/parties/*', port: 1348 },
					{ path: '/api/*', port: 8787 }
				]
			}
		}
	);
	assert.deepEqual(parse_setup_args(['website', '--port=5173']), {
		options: { name: 'website', port: 5173, routes: [] }
	});
	// Syntax Auth's own dev server listens on 37960.
	assert.deepEqual(parse_setup_args(['auth']), {
		options: { name: 'auth', port: 37960, routes: [] }
	});
});

test("a site's setup without its port, or with a bad flag, is refused with what to type", () => {
	assert.deepEqual(parse_setup_args(['lab']), {
		error:
			"Setup for lab needs --port, the port Lab's dev server listens on, for example `pnpm exec syntax-auth-local setup lab --port 1337`. When setup can't finish, the dev server prints this command with its port and routes filled in."
	});
	for (const [args, message] of /** @type {[string[], RegExp][]} */ ([
		[[], /^Setup needs the site's name: auth, lab, or website, not nothing\./],
		[['blog'], /^Setup needs the site's name: auth, lab, or website, not "blog"\./],
		[['lab', '--port'], /^--port needs a port number, not ""\./],
		[['lab', '--port', '70000'], /^--port needs a port number, not "70000"\./],
		[['lab', '--port', '1337', '--route', 'parties=1348'], /^--route needs <path>=<port>/],
		[['lab', '--port', '1337', '--route', "/it's/*=1348"], /^--route needs <path>=<port>/],
		[['lab', '--port', '1337', '--route', '/parties/*'], /^--route needs <path>=<port>/],
		[['lab', '--port', '1337', '--verbose'], /^Setup doesn't know "--verbose"\./]
	])) {
		const parsed = parse_setup_args(args);
		assert.ok('error' in parsed, JSON.stringify(args));
		assert.match(parsed.error, message);
	}
	assert.ok(USAGE.includes('--port <port>'));
});

test('the command refuses a site without its port before setup runs anything', async () => {
	const result = await run(process.execPath, [BIN, 'setup', 'lab'], { timeout_ms: 10_000 });
	assert.equal(result.code, 1);
	assert.match(result.stderr, /^Setup for lab needs --port/);
	assert.equal(result.stdout, '');
});
