// Runs Syntax Auth's own `pnpm dev` or `pnpm preview` on the shared local port, in place of the
// `syntax-auth` container that other Syntax apps use (see CONSUMING_AUTH.md). However it stops
// (Ctrl-C, `kill`, its parent exiting, a crash, or the server losing its port), it stops every
// process it started and starts the container again, so nothing is left running and other apps
// keep signing in.
import { spawn } from 'node:child_process';
import { connect } from 'node:net';

import {
	CONTAINER_NAME,
	SYNTAX_AUTH_LOCAL_PORT,
	docker,
	get_container_state,
	log,
	sleep,
	warn,
	with_container_lock
} from '../packages/auth-local/container.js';

const SERVER_COMMANDS = {
	dev: 'pnpm d1:migrate:local && exec vite dev',
	preview: `pnpm build && exec wrangler dev --env local --ip 127.0.0.1 --port ${SYNTAX_AUTH_LOCAL_PORT}`
};
// Vite restarts its server within about a second when its config changes, so only a longer
// silence means the server has lost the port for good.
const WATCH_INTERVAL_MS = 10_000;
const FAILED_PORT_CHECKS_BEFORE_STOPPING = 3;
const PORT_RELEASE_TIMEOUT_MS = 5_000;
const STOP_GRACE_MS = 5_000;

const server_command = SERVER_COMMANDS[process.argv[2]];
if (!server_command) {
	console.error(`Usage: node scripts/local_server.js <${Object.keys(SERVER_COMMANDS).join('|')}>`);
	process.exit(1);
}

const parent_pid = process.ppid;
/** @type {import('node:child_process').ChildProcess | null} */
let server = null;
/** @type {Promise<never> | null} */
let stopping = null;
/** @type {NodeJS.Timeout | undefined} */
let watch_timer;

function is_port_open() {
	return new Promise((resolve) => {
		const socket = connect({ host: '127.0.0.1', port: SYNTAX_AUTH_LOCAL_PORT });
		socket.setTimeout(2_000);
		socket.once('connect', () => {
			socket.destroy();
			resolve(true);
		});
		socket.once('timeout', () => {
			socket.destroy();
			resolve(false);
		});
		socket.once('error', () => resolve(false));
	});
}

/** @param {number} group_id */
function is_group_running(group_id) {
	try {
		process.kill(-group_id, 0);
		return true;
	} catch {
		return false;
	}
}

/** @param {number} group_id @param {NodeJS.Signals} signal */
function signal_group(group_id, signal) {
	try {
		process.kill(-group_id, signal);
	} catch {
		// Every process in the group has already exited.
	}
}

/** @param {number} group_id @param {number} timeout_ms */
async function wait_for_group_exit(group_id, timeout_ms) {
	const deadline = Date.now() + timeout_ms;
	while (is_group_running(group_id) && Date.now() < deadline) await sleep(100);
}

// Wrangler can outlive its workerd child, or the reverse, so signal the whole process group.
/** @param {number} group_id */
async function stop_server_processes(group_id) {
	signal_group(group_id, 'SIGTERM');
	await wait_for_group_exit(group_id, STOP_GRACE_MS);
	if (!is_group_running(group_id)) return;

	signal_group(group_id, 'SIGKILL');
	await wait_for_group_exit(group_id, STOP_GRACE_MS);
}

async function restart_shared_container() {
	const state = await get_container_state();
	if (!state || state.is_running) return;

	const result = await docker(['start', CONTAINER_NAME]);
	if (result.code === 0) log('Started the shared container again for other Syntax apps');
	else warn(`Unable to start the shared container again: ${result.stderr}`);
}

/** @param {number} exit_code @returns {Promise<never>} */
function stop(exit_code) {
	stopping ??= (async () => {
		clearInterval(watch_timer);
		if (server?.pid) await stop_server_processes(server.pid);
		await with_container_lock(restart_shared_container);
		process.exit(exit_code);
	})();
	return stopping;
}

async function wait_until_port_released() {
	const deadline = Date.now() + PORT_RELEASE_TIMEOUT_MS;
	while (Date.now() < deadline) {
		if (!(await is_port_open())) return true;
		await sleep(250);
	}
	return false;
}

async function wait_until_listening() {
	while (!stopping && server?.exitCode === null && server.signalCode === null) {
		if (await is_port_open()) return;
		await sleep(500);
	}
}

function start_server() {
	// Its own process group, so one signal reaches every process it starts. Being detached also
	// keeps the terminal's Ctrl-C from reaching it directly; `stop` handles that signal instead.
	server = spawn(server_command, { shell: true, detached: true, stdio: 'inherit' });
	server.once('exit', (code) => stop(code ?? 1));
}

// Stops this command when its parent exits (for example, when `pnpm` is killed) or when the
// server stops answering on its port while some of its processes keep running.
function watch_server() {
	let failed_port_checks = 0;
	watch_timer = setInterval(async () => {
		if (process.ppid !== parent_pid) return stop(0);

		failed_port_checks = (await is_port_open()) ? 0 : failed_port_checks + 1;
		if (failed_port_checks < FAILED_PORT_CHECKS_BEFORE_STOPPING) return;

		warn(`Nothing answers on port ${SYNTAX_AUTH_LOCAL_PORT} anymore, so this command is stopping.`);
		stop(1);
	}, WATCH_INTERVAL_MS);
}

for (const signal of /** @type {const} */ (['SIGINT', 'SIGTERM', 'SIGHUP'])) {
	process.on(signal, () => stop(0));
}

log(
	`Stop with Ctrl-C or \`kill ${process.pid}\`. Either stops everything this command started and starts the shared container again.`
);

// Holds the machine-wide container lock until this server listens, so another Syntax app's dev
// server cannot start the container on the port in between.
const is_started = await with_container_lock(async () => {
	if ((await get_container_state())?.is_running) {
		log('Stopping the shared container while this server uses its port');
		await docker(['stop', CONTAINER_NAME]);
	}
	if (!(await wait_until_port_released())) return false;
	if (stopping) return true;

	start_server();
	await wait_until_listening();
	return true;
});

if (!is_started) {
	warn(
		`Another program, perhaps another Syntax Auth server, is using port ${SYNTAX_AUTH_LOCAL_PORT}. Stop it, then try again.`
	);
	process.exit(1);
}
if (!stopping) watch_server();
