// Runs one shared local Syntax Auth for every Syntax app on this machine. Any number of dev servers
// may call this at the same time: container changes are serialized by a machine-wide lock, and each
// holder re-checks the real state before acting.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
	CONTAINER_NAME,
	IMAGE,
	SYNTAX_AUTH_LOCAL_ORIGIN,
	SYNTAX_AUTH_LOCAL_PORT,
	create_container,
	docker,
	ensure_docker,
	find_port_holder,
	first_line,
	get_container_state,
	is_healthy,
	log,
	pull_image,
	sleep,
	warn,
	with_container_lock
} from './container.js';
import { create_plugin } from './plugin.js';
import { default_setup_deps } from './setup.js';

const READY_TIMEOUT_MS = 180_000;
const UPDATER_PATH = fileURLToPath(new URL('./update.js', import.meta.url));

// Downloads the image outside the lock, so a slow first download never makes other apps time out
// waiting. Concurrent pulls of the same image are safe.
/** @returns {Promise<string | null>} null when the image is available, otherwise what is wrong. */
async function ensure_image() {
	if ((await docker(['image', 'inspect', IMAGE])).code === 0) return null;

	log('Downloading local Syntax Auth (first run only)');
	return pull_image();
}

/** @returns {Promise<string | null>} null when Syntax Auth is running or starting. */
async function start_container() {
	// Another dev server may have started it while this one waited for the lock.
	if (await is_healthy()) return null;

	const state = await get_container_state();
	if (!state) return create_container();
	if (state.is_running) return null;

	const result = await docker(['start', CONTAINER_NAME]);
	return result.code === 0 ? null : result.stderr;
}

/** @param {string} error Docker's error from creating or starting the container. */
async function describe_start_error(error) {
	if (!/address already in use|port is already allocated|ports are not available/i.test(error)) {
		return `the ${CONTAINER_NAME} container couldn't start: ${first_line(error)}`;
	}
	const holder = await find_port_holder();
	return holder
		? `port ${SYNTAX_AUTH_LOCAL_PORT} is in use by ${holder}, so local Syntax Auth can't start. Stop that program, then restart dev.`
		: `another program is using port ${SYNTAX_AUTH_LOCAL_PORT}, so local Syntax Auth can't start. Stop it, then restart dev.`;
}

function start_updater() {
	const updater = spawn(process.execPath, [UPDATER_PATH], { detached: true, stdio: 'ignore' });
	updater.on('error', (error) => console.error('Syntax Auth updater failed to start', error));
	updater.unref();
}

/** @returns {Promise<string | null>} null once Syntax Auth answers, otherwise what is wrong. */
async function wait_until_ready() {
	const deadline = Date.now() + READY_TIMEOUT_MS;

	while (Date.now() < deadline) {
		if (await is_healthy()) {
			log(`Ready at ${SYNTAX_AUTH_LOCAL_ORIGIN}`);
			return null;
		}
		await sleep(1_000);
	}

	// The container writes its server's errors to stderr, which `docker logs` passes through.
	const logs = await docker(['logs', '--tail', '20', CONTAINER_NAME]);
	return `local Syntax Auth started but isn't answering at ${SYNTAX_AUTH_LOCAL_ORIGIN} after 3 minutes. Its last log lines:\n${`${logs.stdout}\n${logs.stderr}`.trim()}`;
}

/** @returns {Promise<string | null>} null once Syntax Auth answers, otherwise what is wrong. */
async function start_and_wait() {
	const error = await with_container_lock(start_container);
	return error ? describe_start_error(error) : wait_until_ready();
}

/** Makes sure the shared local Syntax Auth is running. Never throws. */
export async function ensure_syntax_auth() {
	try {
		if (!(await is_healthy())) {
			const problem = (await ensure_docker()) ?? (await ensure_image()) ?? (await start_and_wait());
			if (problem) {
				warn(`Running signed out: ${problem}`);
				return;
			}
		}

		start_updater();
	} catch (error) {
		console.error('Syntax Auth local startup failed', error);
	}
}

/**
 * Vite plugin: whenever the dev server starts, ensures local Syntax Auth without delaying it, and,
 * given a site name, sets up that site's https://*.syntax.test name (see README.md).
 * @param {import('./plugin.js').SyntaxAuthOptions} [options]
 */
export function syntax_auth(options = {}) {
	return create_plugin(options, { ...default_setup_deps(), ensure_syntax_auth });
}
