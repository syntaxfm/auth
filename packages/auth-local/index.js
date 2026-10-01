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
	find_port_holder,
	first_line,
	get_container_state,
	is_healthy,
	is_missing_command,
	log,
	pull_image,
	sleep,
	warn,
	with_container_lock
} from './container.js';
const READY_TIMEOUT_MS = 180_000;
const DOCKER_START_TIMEOUT_MS = 120_000;
const UPDATER_PATH = fileURLToPath(new URL('./update.js', import.meta.url));

async function is_docker_running() {
	return (await docker(['info', '--format', '{{.ServerVersion}}'])).code === 0;
}

/** @param {string} app */
function open_app(app) {
	return new Promise((resolve) => {
		const child = spawn('open', ['--background', '-a', app], { stdio: 'ignore' });
		child.on('error', () => resolve(false));
		child.on('close', (code) => resolve(code === 0));
	});
}

// On macOS, opens the Docker app that Docker's current context points at, then waits for it.
/** @returns {Promise<string | null>} null when Docker is ready, otherwise what is wrong. */
async function start_docker_app() {
	const context = await docker(['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}']);
	const apps = context.stdout.includes('orbstack')
		? ['OrbStack', 'Docker Desktop']
		: ['Docker Desktop', 'OrbStack'];

	for (const app of apps) {
		if (!(await open_app(app === 'Docker Desktop' ? 'Docker' : app))) continue;

		log(`Starting ${app}`);
		const deadline = Date.now() + DOCKER_START_TIMEOUT_MS;
		while (Date.now() < deadline) {
			if (await is_docker_running()) return null;
			await sleep(1_000);
		}
		return `${app} was opened, but Docker wasn't ready after 2 minutes. Check ${app} for an error or a prompt, then restart dev.`;
	}
	return 'Docker is installed but not running, and neither Docker Desktop nor OrbStack is installed to start it. Start your Docker engine, then restart dev.';
}

/** @returns {Promise<string | null>} null when Docker is ready, otherwise what is wrong. */
async function ensure_docker() {
	const info = await docker(['info', '--format', '{{.ServerVersion}}']);
	if (info.code === 0) return null;
	if (is_missing_command(info)) {
		return "Docker isn't installed. Install Docker Desktop (https://www.docker.com/products/docker-desktop/) or OrbStack (https://orbstack.dev), then restart dev.";
	}
	if (/permission denied/i.test(info.stderr)) {
		return `Docker is installed, but your user can't use it (${first_line(info.stderr)}). On Linux, add yourself to the docker group (https://docs.docker.com/engine/install/linux-postinstall/), then restart dev.`;
	}
	if (process.platform === 'darwin') return start_docker_app();
	return `Docker is installed but not running (${first_line(info.stderr)}). Start it (for example \`sudo systemctl start docker\`), then restart dev.`;
}

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
