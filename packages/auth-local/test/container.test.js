// Running commands with a time limit, and refusing system commands under a test runner.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { refused_under_tests, run } from '../container.js';

test('under a test runner, a command that could show a dialog or change this computer never starts', async () => {
	// This file runs under node --test, which sets NODE_TEST_CONTEXT. The paths don't exist, so
	// even a broken guard could only fail to spawn them.
	assert.ok(process.env.NODE_TEST_CONTEXT);
	for (const [command, ...args] of [
		['/nonexistent/osascript', '-e', 'do shell script "true" with administrator privileges'],
		['/nonexistent/sudo', 'true'],
		['/nonexistent/open', '--background', '-a', 'Docker'],
		['/nonexistent/docker', 'run', 'caddy'],
		['/nonexistent/security', 'add-trusted-cert', 'root.pem']
	]) {
		const result = await run(command, args);
		assert.equal(result.code, null);
		assert.match(
			result.stderr,
			/^`.+` was refused: tests \(NODE_TEST_CONTEXT is set\) must use a stand-in for it$/,
			command
		);
	}

	// A marker counts when set at all, even to "", "0", or "false".
	for (const env of [
		{ NODE_TEST_CONTEXT: 'child-v8' },
		{ VITEST: 'true' },
		{ NODE_TEST_CONTEXT: '' },
		{ VITEST: '' },
		{ VITEST: 'false' }
	]) {
		assert.ok(refused_under_tests('open', ['--background', '-a', 'Docker'], env));
		assert.ok(refused_under_tests('/usr/bin/osascript', ['-e', 'x'], env));
		assert.ok(refused_under_tests('security', ['delete-certificate', '-Z', 'abc'], env));
		assert.equal(refused_under_tests('security', ['verify-cert', '-c', 'leaf.pem'], env), null);
		assert.equal(refused_under_tests('security', ['find-certificate', '-a'], env), null);
		assert.equal(refused_under_tests('/bin/sh', ['-c', 'true'], env), null);
	}
	assert.equal(refused_under_tests('osascript', ['-e', 'x'], {}), null);
});

test(
	'a command that ignores SIGTERM is killed after a short grace, and the result names it',
	{ timeout: 5_000 },
	async () => {
		const started = Date.now();
		const result = await run(
			process.execPath,
			['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"],
			{ timeout_ms: 150, kill_grace_ms: 100 }
		);
		const elapsed = Date.now() - started;
		assert.ok(elapsed < 600, `took ${elapsed} ms`);
		assert.equal(result.timed_out, true);
		assert.equal(result.code, null);
		assert.equal(
			result.stderr,
			`\`${process.execPath} -e …\` didn't finish within 150 ms, so it was stopped`
		);
	}
);

test(
	"a grandchild holding the command's output open doesn't keep it running past its limit",
	{ timeout: 5_000 },
	async () => {
		const started = Date.now();
		const result = await run('/bin/sh', ['-c', "trap '' TERM; sleep 5 & wait"], {
			timeout_ms: 150,
			kill_grace_ms: 100
		});
		assert.ok(Date.now() - started < 1_000, `took ${Date.now() - started} ms`);
		assert.equal(result.timed_out, true);
	}
);
