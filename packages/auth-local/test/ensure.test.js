// Local Syntax Auth's own startup (ensure_syntax_auth): a command that stalls ends the start with a
// message naming it and its fix, for each class of limit, and the Docker app opens once at a time.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { run as real_run, stall_message, with_port_lock } from '../container.js';
import { ensure_syntax_auth } from '../index.js';
import { free_port } from './stand_ins.js';

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

/**
 * Docker on a Mac where the engine isn't running: `open -a Docker` opens the app, which answers
 * `docker info` after `ready_ms` (never, when null). Syntax Auth's image is there and its container
 * starts on `docker run`.
 * @param {number | null} ready_ms
 */
function sleeping_docker(ready_ms) {
	/** @type {string[]} */
	const calls = [];
	/** @type {number | null} */
	let opened_at = null;
	let started = false;
	const is_ready = () =>
		opened_at !== null && ready_ms !== null && Date.now() - opened_at >= ready_ms;
	/** @type {import('../container.js').Run} */
	const run = async (command, args) => {
		calls.push(`${command} ${args.join(' ')}`);
		if (command === 'open') {
			opened_at ??= Date.now();
			return ok();
		}
		if (args[0] === 'info')
			return is_ready() ? ok('29.5.3') : fail('Cannot connect to the Docker daemon');
		if (args[0] === 'context') return ok('unix:///Users/test/.docker/run/docker.sock');
		if (args[0] === 'image') return ok();
		if (args[0] === 'container') return fail('Error: No such container: syntax-auth');
		if (args[0] === 'run') {
			started = true;
			return ok('container-id');
		}
		return fail(`unexpected ${command} ${args[0]}`);
	};
	return {
		run,
		calls,
		opens: () => calls.filter((call) => call.startsWith('open ')),
		is_started: () => started
	};
}

/** @param {ReturnType<typeof sleeping_docker>} docker @param {string} directory @param {number} lock_port */
function start_on(docker, directory, lock_port) {
	return start(docker.run, {
		is_healthy: async () => docker.is_started(),
		container_lock: (task) => with_port_lock(lock_port, task),
		docker_start: {
			platform: 'darwin',
			result_path: join(directory, 'docker-start.json'),
			ready_timeout_ms: 300,
			poll_ms: 10
		}
	});
}

test('two dev servers starting at once open Docker once, and both start', async () => {
	const directory = await mkdtemp(join(tmpdir(), 'syntax-auth-docker-'));
	try {
		const docker = sleeping_docker(100);
		const lock_port = await free_port();
		const both = await Promise.all([
			start_on(docker, directory, lock_port),
			start_on(docker, directory, lock_port)
		]);
		assert.deepEqual(both, [
			{ warnings: [], updaters: 1 },
			{ warnings: [], updaters: 1 }
		]);
		assert.deepEqual(docker.opens(), ['open --background -a Docker']);
		assert.equal(docker.calls.filter((call) => call.startsWith('docker run')).length, 1);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("a dev server that waited for another's Docker start gets that start's failure, and never opens Docker again", async () => {
	const directory = await mkdtemp(join(tmpdir(), 'syntax-auth-docker-'));
	try {
		const docker = sleeping_docker(null);
		const lock_port = await free_port();
		const message =
			"Running signed out: Docker Desktop was opened, but Docker wasn't ready after 300 ms. Check Docker Desktop for an error or a prompt, then restart dev.";
		const both = await Promise.all([
			start_on(docker, directory, lock_port),
			start_on(docker, directory, lock_port)
		]);
		assert.deepEqual(both, [
			{ warnings: [message], updaters: 0 },
			{ warnings: [message], updaters: 0 }
		]);
		assert.deepEqual(docker.opens(), ['open --background -a Docker']);

		// A start after both ended is a retry: it opens Docker itself.
		assert.deepEqual(await start_on(docker, directory, lock_port), {
			warnings: [message],
			updaters: 0
		});
		assert.equal(docker.opens().length, 2);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
