// Running commands with a time limit, refusing system commands under a test runner, and reading
// netstat's listeners.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { find_port_listeners, refused_under_tests, run } from '../container.js';

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

	for (const env of [{ NODE_TEST_CONTEXT: 'child-v8' }, { VITEST: 'true' }]) {
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
			`\`${process.execPath} -e …\` didn't finish within 150 ms, so setup stopped it`
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

/** @param {string} stdout @param {{ code?: number, stderr?: string }} [options] */
const netstat =
	(stdout, { code = 0, stderr = '' } = {}) =>
	/** @type {import('../container.js').Run} */
	async (command, args) => {
		if (command === 'ps')
			return args.at(-1) === '610'
				? { code: 0, stdout: '/opt/homebrew/bin/caddy', stderr: '' }
				: { code: 1, stdout: '', stderr: '' };
		return { code, stdout, stderr };
	};

const NAMED_HEADER =
	'Proto Recv-Q Send-Q  Local Address          Foreign Address        (state)          rxbytes      txbytes  rhiwat  shiwat          process:pid    state  options           gencnt    flags   flags1 usecnt rtncnt fltrs';
const NUMERIC_HEADER =
	'Proto Recv-Q Send-Q  Local Address          Foreign Address        (state)     rhiwat shiwat    pid   epid  state    options           gencnt    flags   flags1 usscnt rtncnt fltrs';

test('netstat listeners are read by their header, named or numeric', async () => {
	const named = [
		'Active Internet connections (including servers)',
		NAMED_HEADER,
		'tcp46      0      0  *.443                  *.*                    LISTEN                 0            0  131072  131072      Helium Helper:5660   00100 00000006 00000000000c38ca 00000000 00000800      1      0 000000',
		'tcp4       0      0  127.0.0.1.443          127.0.0.1.50000        ESTABLISHED            0            0  131072  131072            caddy:610    00102 00000008 00000000000e4a9a 00000081 04000900      2      0 000000',
		'tcp4       0      0  127.0.0.1.4430         *.*                    LISTEN                 0            0  131072  131072            other:611    00100 00000006 00000000000c38ca 00000000 00000800      1      0 000000'
	].join('\n');
	assert.deepEqual(await find_port_listeners(443, netstat(named)), {
		listeners: [{ proto: 'tcp46', address: '*', process: 'Helium Helper', pid: 5660 }]
	});

	const numeric = [
		NUMERIC_HEADER,
		'tcp4 0 0 *.443 *.* LISTEN 131072 131072 610 0 0x0000 0x0000 00000000 00000000',
		'tcp6 0 0 ::1.443 *.* LISTEN 131072 131072 612 0 0x0000 0x0000 00000000 00000000'
	].join('\n');
	assert.deepEqual(await find_port_listeners(443, netstat(numeric)), {
		listeners: [
			{ proto: 'tcp4', address: '*', process: 'caddy', pid: 610 },
			{ proto: 'tcp6', address: '::1', process: 'a program', pid: 612 }
		]
	});
});

test('a failed or unreadable netstat is an error, never "nothing listens"', async () => {
	assert.deepEqual(
		await find_port_listeners(
			443,
			netstat('', { code: 1, stderr: 'netstat: Operation not permitted' })
		),
		{ error: '`netstat -anv -p tcp` failed: netstat: Operation not permitted' }
	);
	assert.deepEqual(await find_port_listeners(443, netstat('tcp4 0 0 *.443 *.* LISTEN 1 2 3')), {
		error:
			'`netstat -anv -p tcp` printed a format setup can\'t read (no "Proto … Local Address … process:pid" or "pid" header)'
	});
	assert.deepEqual(
		await find_port_listeners(
			443,
			netstat(`${NUMERIC_HEADER}\ntcp4 0 0 *.443 *.* LISTEN 131072 131072 - 0`)
		),
		{ error: '`netstat -anv -p tcp` printed a listener on port 443 without a process id' }
	);
});
