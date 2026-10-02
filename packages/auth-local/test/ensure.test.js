// Local Syntax Auth's own startup (ensure_syntax_auth): a command that stalls ends the start with a
// message naming it and its fix, for each class of limit.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { run as real_run, stall_message } from '../container.js';
import { ensure_syntax_auth } from '../index.js';

/** @param {string} stdout */
const ok = (stdout = '') => ({ code: 0, stdout, stderr: '' });
/** @param {string} stderr */
const fail = (stderr) => ({ code: 1, stdout: '', stderr });

/**
 * Docker on a Mac where Syntax Auth's image and container are missing, and `stalled` (like
 * "docker pull") hangs until its limit, then gives what `run` gives for a stopped command. A stalled
 * command without a limit fails the test instead of hanging it.
 * @param {string} stalled
 */
function stalling_docker(stalled) {
	/** @type {string[]} */
	const calls = [];
	/** @type {import('../container.js').Run} */
	const run = async (command, args, options = {}) => {
		calls.push(`${command} ${args[0]}`);
		if (`${command} ${args[0]}` === stalled) {
			assert.ok(options.timeout_ms, `${stalled} ran without a time limit`);
			return {
				code: null,
				stdout: '',
				stderr: stall_message(command, args, options.timeout_ms),
				timed_out: true
			};
		}
		if (args[0] === 'info') return ok('29.5.3');
		if (args[0] === 'image') return fail('Error: No such image');
		if (args[0] === 'pull') return ok();
		if (args[0] === 'container') return fail('Error: No such container: syntax-auth');
		return ok('container-id');
	};
	return { run, calls };
}

/** @param {import('../container.js').Run} run @param {Parameters<typeof ensure_syntax_auth>[0]} [options] */
async function start(run, options = {}) {
	/** @type {string[]} */
	const warnings = [];
	let updaters = 0;
	await ensure_syntax_auth({
		run,
		is_healthy: async () => false,
		start_updater: () => void updaters++,
		warn: (message) => void warnings.push(message),
		container_lock: (task) => task(),
		...options
	});
	return { warnings, updaters };
}

test('a stalled Docker inspection (30 seconds) ends the start and says Docker is stuck', async () => {
	const docker = stalling_docker('docker info');
	assert.deepEqual(await start(docker.run), {
		warnings: [
			"Running signed out: `docker info --format {{.ServerVersion}}` didn't finish within 30 seconds, so local Syntax Auth's startup stopped it. Docker isn't answering. Quit and reopen Docker Desktop or OrbStack (or restart your Docker engine), then restart dev."
		],
		updaters: 0
	});
	assert.deepEqual(docker.calls, ['docker info']);
});

test('a stalled image download (10 minutes) ends the start and points at the connection', async () => {
	const docker = stalling_docker('docker pull');
	assert.deepEqual(await start(docker.run), {
		warnings: [
			"Running signed out: `docker pull --quiet ghcr.io/syntaxfm/auth-local:latest` didn't finish within 600 seconds, so local Syntax Auth's startup stopped it. The download is stuck or too slow. Check your internet connection, then restart dev."
		],
		updaters: 0
	});
	assert.deepEqual(docker.calls, ['docker info', 'docker image', 'docker pull']);
});

test('a stalled container start (2 minutes) ends the start and points at Docker', async () => {
	const docker = stalling_docker('docker run');
	assert.deepEqual(await start(docker.run), {
		warnings: [
			"Running signed out: `docker run --detach --init --name …` didn't finish within 120 seconds, so local Syntax Auth's startup stopped it. Docker is stuck starting the syntax-auth container. Check Docker Desktop or OrbStack for an error or a prompt (or restart your Docker engine), then restart dev."
		],
		updaters: 0
	});
	assert.deepEqual(docker.calls, [
		'docker info',
		'docker image',
		'docker pull',
		'docker container',
		'docker run'
	]);
});

test(
	'a real command that ignores SIGTERM is killed at its limit, and the start says which one',
	{ timeout: 5_000 },
	async () => {
		/** Every command is a process that ignores SIGTERM, run by the real `run`. */
		/** @type {import('../container.js').Run} */
		const run = (_command, _args, options) =>
			real_run(
				process.execPath,
				['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"],
				options
			);
		const started = Date.now();
		const result = await start(run, { limits: { inspect_ms: 150, kill_grace_ms: 100 } });
		assert.ok(Date.now() - started < 1_000, `took ${Date.now() - started} ms`);
		assert.deepEqual(result, {
			warnings: [
				"Running signed out: `docker info --format {{.ServerVersion}}` didn't finish within 150 ms, so local Syntax Auth's startup stopped it. Docker isn't answering. Quit and reopen Docker Desktop or OrbStack (or restart your Docker engine), then restart dev."
			],
			updaters: 0
		});
	}
);
