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
	get_container_state,
	is_healthy,
	log,
	pull_image,
	sleep,
	warn,
	with_container_lock
} from './container.js';

const NO_ACCESS_MESSAGE =
	'Signed-out mode: local Syntax Auth is for the Syntax team. Team members run ' +
	'`gh auth refresh -h github.com -s read:packages` once, then restart dev.';
const READY_TIMEOUT_MS = 180_000;
const DOCKER_START_TIMEOUT_MS = 120_000;
const UPDATER_PATH = fileURLToPath(new URL('./update.js', import.meta.url));

async function is_docker_running() {
	return (await docker(['info', '--format', '{{.ServerVersion}}'])).code === 0;
}

// Launches Docker Desktop on macOS when it is installed but closed, then waits for the daemon.
async function start_docker() {
	if (process.platform !== 'darwin') return false;

	const is_launched = await new Promise((resolve) => {
		const child = spawn('open', ['--background', '-a', 'Docker'], { stdio: 'ignore' });
		child.on('error', () => resolve(false));
		child.on('close', (code) => resolve(code === 0));
	});
	if (!is_launched) return false;

	log('Starting Docker');
	const deadline = Date.now() + DOCKER_START_TIMEOUT_MS;
	while (Date.now() < deadline) {
		if (await is_docker_running()) return true;
		await sleep(1_000);
	}
	return false;
}

// Downloads the image outside the lock, so a slow first download never makes other apps time out
// waiting. Concurrent pulls of the same image are safe.
/** @returns {Promise<string | null>} null when the image is available locally. */
async function ensure_image() {
	if ((await docker(['image', 'inspect', IMAGE])).code === 0) return null;

	log('Downloading local Syntax Auth (first run only)');
	const { error, is_denied } = await pull_image();
	return is_denied ? NO_ACCESS_MESSAGE : error;
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

function start_updater() {
	const updater = spawn(process.execPath, [UPDATER_PATH], { detached: true, stdio: 'ignore' });
	updater.on('error', (error) => console.error('Syntax Auth updater failed to start', error));
	updater.unref();
}

async function wait_until_ready() {
	const deadline = Date.now() + READY_TIMEOUT_MS;

	while (Date.now() < deadline) {
		if (await is_healthy()) {
			log(`Ready at ${SYNTAX_AUTH_LOCAL_ORIGIN}`);
			return;
		}
		await sleep(1_000);
	}

	warn(`Not responding at ${SYNTAX_AUTH_LOCAL_ORIGIN}. Check \`docker logs ${CONTAINER_NAME}\`.`);
}

/** Makes sure the shared local Syntax Auth is running. Never throws. */
export async function ensure_syntax_auth() {
	try {
		if (!(await is_healthy())) {
			if (!(await is_docker_running()) && !(await start_docker())) {
				warn('Docker is unavailable, so sign-in is unavailable. Install or start Docker.');
				return;
			}

			const error = (await ensure_image()) ?? (await with_container_lock(start_container));
			if (error === NO_ACCESS_MESSAGE) {
				warn(error);
				return;
			}
			if (error) {
				warn(
					error.includes('address already in use')
						? `Another program is using port ${SYNTAX_AUTH_LOCAL_PORT}. Stop it, then restart dev.`
						: `Unable to start: ${error}`
				);
				return;
			}

			await wait_until_ready();
		}

		start_updater();
	} catch (error) {
		console.error('Syntax Auth local startup failed', error);
	}
}

/** Vite plugin: ensures local Syntax Auth whenever the dev server starts, without delaying it. */
export function syntax_auth() {
	return {
		name: 'syntax-auth-local',
		apply: 'serve',
		configureServer() {
			// Vitest also runs Vite in serve mode; tests must not start containers.
			if (process.env.VITEST) return;
			ensure_syntax_auth().catch((error) =>
				console.error('Syntax Auth local startup failed', error)
			);
		}
	};
}
