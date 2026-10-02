// Runs one shared local Syntax Auth for every Syntax app on this machine. Any number of dev servers
// may call this at the same time: container changes are serialized by a machine-wide lock, and each
// holder re-checks the real state before acting.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
	CONTAINER_NAME,
	IMAGE,
	STARTUP_LIMITS,
	StalledCommand,
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
	run,
	sleep,
	warn,
	with_container_lock,
	with_startup_limits
} from './container.js';
import { create_plugin } from './plugin.js';
import { default_setup_deps, why_not_open } from './setup.js';

const READY_TIMEOUT_MS = 180_000;
const UPDATER_PATH = fileURLToPath(new URL('./update.js', import.meta.url));

/**
 * @typedef {object} EnsureOptions
 * @property {boolean} [can_start] false: only check, never start Docker, the container, or the updater
 * @property {NodeJS.ProcessEnv} [env] decides whether the Docker app may be opened (see why_not_open)
 * @property {import('./container.js').Run} [run]
 * @property {() => Promise<boolean>} [is_healthy]
 * @property {() => void} [start_updater]
 * @property {(message: string) => void} [warn]
 * @property {<T>(task: () => Promise<T>) => Promise<T>} [container_lock] also serializes opening the Docker app
 * @property {Partial<import('./container.js').StartupLimits>} [limits] see STARTUP_LIMITS
 * @property {Partial<Omit<import('./container.js').DockerStartOptions, 'lock'>>} [docker_start] see DOCKER_START
 */

// Downloads the image outside the lock, so a slow first download never makes other apps time out
// waiting. Concurrent pulls of the same image are safe.
/**
 * @param {import('./container.js').Run} run_command
 * @returns {Promise<string | null>} null when the image is available, otherwise what is wrong.
 */
async function ensure_image(run_command) {
	if ((await docker(['image', 'inspect', IMAGE], run_command)).code === 0) return null;

	log('Downloading local Syntax Auth (first run only)');
	return pull_image(run_command);
}

/**
 * @param {import('./container.js').Run} run_command
 * @param {() => Promise<boolean>} check
 * @returns {Promise<string | null>} null when Syntax Auth is running or starting.
 */
async function start_container(run_command, check) {
	// Another dev server may have started it while this one waited for the lock.
	if (await check()) return null;

	const state = await get_container_state(run_command);
	if (!state) return create_container(run_command);
	if (state.is_running) return null;

	const result = await docker(['start', CONTAINER_NAME], run_command);
	return result.code === 0 ? null : result.stderr;
}

/**
 * @param {string} error Docker's error from creating or starting the container.
 * @param {import('./container.js').Run} run_command
 */
async function describe_start_error(error, run_command) {
	if (!/address already in use|port is already allocated|ports are not available/i.test(error)) {
		return `the ${CONTAINER_NAME} container couldn't start: ${first_line(error)}`;
	}
	const holder = await find_port_holder(run_command);
	return holder
		? `port ${SYNTAX_AUTH_LOCAL_PORT} is in use by ${holder}, so local Syntax Auth can't start. Stop that program, then restart dev.`
		: `another program is using port ${SYNTAX_AUTH_LOCAL_PORT}, so local Syntax Auth can't start. Stop it, then restart dev.`;
}

function start_updater() {
	const updater = spawn(process.execPath, [UPDATER_PATH], { detached: true, stdio: 'ignore' });
	updater.on('error', (error) => console.error('Syntax Auth updater failed to start', error));
	updater.unref();
}

/**
 * @param {import('./container.js').Run} run_command
 * @param {() => Promise<boolean>} check
 * @returns {Promise<string | null>} null once Syntax Auth answers, otherwise what is wrong.
 */
async function wait_until_ready(run_command, check) {
	const deadline = Date.now() + READY_TIMEOUT_MS;

	while (Date.now() < deadline) {
		if (await check()) {
			log(`Ready at ${SYNTAX_AUTH_LOCAL_ORIGIN}`);
			return null;
		}
		await sleep(1_000);
	}

	// The container writes its server's errors to stderr, which `docker logs` passes through.
	const logs = await docker(['logs', '--tail', '20', CONTAINER_NAME], run_command);
	return `local Syntax Auth started but isn't answering at ${SYNTAX_AUTH_LOCAL_ORIGIN} after 3 minutes. Its last log lines:\n${`${logs.stdout}\n${logs.stderr}`.trim()}`;
}

/**
 * @param {import('./container.js').Run} run_command
 * @param {() => Promise<boolean>} check
 * @param {<T>(task: () => Promise<T>) => Promise<T>} lock
 * @returns {Promise<string | null>} null once Syntax Auth answers, otherwise what is wrong.
 */
async function start_and_wait(run_command, check, lock) {
	const error = await lock(() => start_container(run_command, check));
	return error ? describe_start_error(error, run_command) : wait_until_ready(run_command, check);
}

/**
 * Makes sure the shared local Syntax Auth is running. Never throws. With `can_start: false` (a
 * site's dev server on Linux, or where nobody is at the Mac's screen) it only checks, and says how
 * to start it. Every command it runs has a time limit (see STARTUP_LIMITS); one that stalls is
 * stopped, and the app runs signed out with a message naming it. It opens Docker Desktop or OrbStack
 * only with a person at the Mac's screen: never from an agent shell, over SSH, in CI, under a test
 * runner, or outside the desktop session (unless SYNTAX_DEV_SETUP_DIALOGS=allow, at the screen), so
 * no dialog of Docker's own appears there. Starting the container when Docker runs shows none.
 * @param {EnsureOptions} [options]
 */
export async function ensure_syntax_auth({
	can_start = true,
	env = process.env,
	run: unbounded_run = run,
	is_healthy: check = is_healthy,
	start_updater: updater = start_updater,
	warn: report = warn,
	container_lock = with_container_lock,
	limits = {},
	docker_start = {}
} = {}) {
	const run_command = with_startup_limits(unbounded_run, { ...STARTUP_LIMITS, ...limits });
	try {
		if (!(await check())) {
			if (!can_start) {
				report(
					`Running signed out: local Syntax Auth isn't running, and this dev server starts it only on a Mac with a person at its screen. Run \`pnpm exec syntax-auth-local\` to start it, then restart dev.`
				);
				return;
			}
			const problem =
				(await ensure_docker(run_command, {
					...docker_start,
					lock: container_lock,
					why_not_open: () => why_not_open({ run: run_command, env })
				})) ??
				(await ensure_image(run_command)) ??
				(await start_and_wait(run_command, check, container_lock));
			if (problem) {
				report(`Running signed out: ${problem}`);
				return;
			}
		}

		if (can_start) updater();
	} catch (error) {
		if (error instanceof StalledCommand) {
			report(`Running signed out: ${error.message}`);
			return;
		}
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
