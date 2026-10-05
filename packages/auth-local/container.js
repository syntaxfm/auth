// Docker, process, and locking internals shared by the dev-server entry (index.js), Syntax Auth's
// own `pnpm dev` (scripts/local_server.js), and the detached updater.
import { spawn } from 'node:child_process';
import { access, constants, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, delimiter, join } from 'node:path';

export const SYNTAX_AUTH_LOCAL_PORT = 37960;
export const SYNTAX_AUTH_LOCAL_ORIGIN = `http://localhost:${SYNTAX_AUTH_LOCAL_PORT}`;
export const CONTAINER_NAME = 'syntax-auth';
export const IMAGE = 'ghcr.io/syntaxfm/auth-local:latest';

// Holding this port is a machine-wide lock for changing a container. The OS releases it the moment
// the holder exits, so a crashed or interrupted process can never leave a stale lock.
export const CONTAINER_LOCK_PORT = 37961;
const LOCK_TIMEOUT_MS = 300_000;
const DOCKER_START_TIMEOUT_MS = 120_000;
const VOLUME_NAME = 'syntax-auth';
const NAME_IN_USE = 'is already in use';

/** @param {number} ms */
export function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** @param {string} message */
export function log(message) {
	console.log(`[syntax-auth] ${message}`);
}

/** @param {string} message */
export function warn(message) {
	console.warn(`[syntax-auth] ${message}`);
}

/**
 * @typedef {{ code: number | null, stdout: string, stderr: string, timed_out?: boolean }} RunResult
 * @typedef {(command: string, args: string[], options?: RunOptions) => Promise<RunResult>} Run
 * @typedef {{ input?: string, env?: NodeJS.ProcessEnv, timeout_ms?: number, kill_grace_ms?: number }} RunOptions
 */

const KILL_GRACE_MS = 2_000;

/**
 * The command as a person would type it, shortened: long arguments (like a whole script) become "…".
 * @param {string} command
 * @param {string[]} args
 */
export function describe_command(command, args) {
	const shown = args.slice(0, 4).map((arg) => (arg.length > 80 || /\s/.test(arg) ? '…' : arg));
	return [command, ...shown, ...(args.length > 4 ? ['…'] : [])].join(' ');
}

/**
 * What a timed-out command reports in place of its stderr.
 * @param {string} command
 * @param {string[]} args
 * @param {number} timeout_ms
 */
export function stall_message(command, args, timeout_ms) {
	return `\`${describe_command(command, args)}\` didn't finish within ${describe_limit(timeout_ms)}, so it was stopped`;
}

/** @param {number} ms @returns {string} like "2 minutes", or as describe_limit gives it */
function describe_wait(ms) {
	if (ms < 60_000 || ms % 60_000 !== 0) return describe_limit(ms);
	const minutes = ms / 60_000;
	return `${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`;
}

/** @param {number} timeout_ms @returns {string} like "30 seconds" or "150 ms" */
function describe_limit(timeout_ms) {
	const seconds = Math.round(timeout_ms / 1_000);
	return timeout_ms >= 1_000
		? `${seconds} ${seconds === 1 ? 'second' : 'seconds'}`
		: `${timeout_ms} ms`;
}

/**
 * Whether `name` is set at all in `env`. A marker like CI or PI_CODING_AGENT counts whatever its
 * value, even "", "0", or "false": only an unset variable means it isn't there.
 * @param {NodeJS.ProcessEnv} env
 * @param {string} name
 */
export function is_set(env, name) {
	return env[name] !== undefined;
}

// The read-only `security` subcommands; every other one can change the keychain or show a dialog.
const READ_ONLY_SECURITY = new Set(['verify-cert', 'find-certificate']);

/**
 * Why `command` must not run under a test runner, or null. Tests use stand-ins for every command
 * that can show a dialog or change this computer (osascript, the keychain, sudo, opening an app,
 * docker), so a test that reaches the real one is a bug: it fails instead of acting.
 * @param {string} command
 * @param {string[]} args
 * @param {NodeJS.ProcessEnv} env
 */
export function refused_under_tests(command, args, env) {
	const runner = ['NODE_TEST_CONTEXT', 'VITEST'].find((name) => is_set(env, name));
	if (!runner) return null;
	const name = basename(command);
	const is_refused =
		['osascript', 'sudo', 'open', 'docker'].includes(name) ||
		(name === 'security' && !READ_ONLY_SECURITY.has(args[0] ?? ''));
	return is_refused
		? `\`${describe_command(command, args)}\` was refused: tests (${runner} is set) must use a stand-in for it`
		: null;
}

/**
 * Runs a command to completion. Never throws: a missing command gives code null and its error. A
 * command still running after `timeout_ms` gets SIGTERM, then SIGKILL after `kill_grace_ms`, and
 * gives `timed_out: true` with a stderr that names the command. Under a test runner, a command that
 * could show a dialog or change this computer never starts (see refused_under_tests).
 * @type {Run}
 */
export function run(command, args, { input, env, timeout_ms, kill_grace_ms = KILL_GRACE_MS } = {}) {
	const refusal = refused_under_tests(command, args, process.env);
	if (refusal) return Promise.resolve({ code: null, stdout: '', stderr: refusal });
	return new Promise((resolve) => {
		const child = spawn(command, args, {
			env: env ?? process.env,
			stdio: ['pipe', 'pipe', 'pipe']
		});
		let stdout = '';
		let stderr = '';
		let timed_out = false;
		let settled = false;
		/** @type {NodeJS.Timeout[]} */
		const timers = [];
		/** @param {RunResult} result */
		const finish = (result) => {
			if (settled) return;
			settled = true;
			for (const timer of timers) clearTimeout(timer);
			resolve(result);
		};
		const stalled = () => ({
			code: null,
			stdout: stdout.trim(),
			stderr: stall_message(command, args, Number(timeout_ms)),
			timed_out: true
		});
		if (timeout_ms) {
			timers.push(
				setTimeout(() => {
					timed_out = true;
					child.kill('SIGTERM');
					timers.push(
						setTimeout(() => {
							child.kill('SIGKILL');
							// A grandchild may still hold the pipes open; stop waiting for them.
							timers.push(setTimeout(() => finish(stalled()), kill_grace_ms));
						}, kill_grace_ms)
					);
				}, timeout_ms)
			);
		}
		child.stdout.on('data', (chunk) => (stdout += chunk));
		child.stderr.on('data', (chunk) => (stderr += chunk));
		child.on('error', (error) => finish({ code: null, stdout, stderr: error.message }));
		child.on('exit', () => {
			if (!timed_out) return;
			child.stdout.destroy();
			child.stderr.destroy();
			finish(stalled());
		});
		child.on('close', (code) => {
			finish(timed_out ? stalled() : { code, stdout: stdout.trim(), stderr: stderr.trim() });
		});
		child.stdin.on('error', () => {
			// The command exited before reading its input; `close` reports how it ended.
		});
		child.stdin.end(input);
	});
}

/**
 * How long each command of local Syntax Auth's startup (ensure_syntax_auth) may run before it gets
 * SIGTERM, then SIGKILL after `kill_grace_ms`.
 * - `inspect_ms`, 30 seconds: reading Docker's state (`docker info`, `docker context inspect`,
 *   `docker image inspect`, `docker container inspect`, `docker logs`), opening the Docker app,
 *   `gh`, `docker login`, and `lsof` answer within seconds when they work, so 30 means stuck.
 * - `download_ms`, 10 minutes: `docker pull` of the image, which the first run downloads whole;
 *   room for a slow connection.
 * - `start_ms`, 2 minutes: `docker run` and `docker start` of the container, which may first wait
 *   for Docker to create the volume and set up the port forward on a busy Docker VM.
 * @typedef {{ inspect_ms: number, download_ms: number, start_ms: number, kill_grace_ms: number }} StartupLimits
 */
/** @type {StartupLimits} */
export const STARTUP_LIMITS = {
	inspect_ms: 30_000,
	download_ms: 600_000,
	start_ms: 120_000,
	kill_grace_ms: KILL_GRACE_MS
};

/** A startup command ran past its limit; the message names it and says what to do. */
export class StalledCommand extends Error {}

/**
 * The limit for one startup command, and what to do when it stalls.
 * @param {string} command
 * @param {string[]} args
 * @param {StartupLimits} limits
 * @returns {{ timeout_ms: number, fix: string }}
 */
function startup_limit(command, args, limits) {
	if (command === 'docker' && args[0] === 'pull') {
		return {
			timeout_ms: limits.download_ms,
			fix: 'The download is stuck or too slow. Check your internet connection, then restart dev.'
		};
	}
	if (command === 'docker' && (args[0] === 'run' || args[0] === 'start')) {
		return {
			timeout_ms: limits.start_ms,
			fix: `Docker is stuck starting the ${CONTAINER_NAME} container. Check Docker Desktop or OrbStack for an error or a prompt (or restart your Docker engine), then restart dev.`
		};
	}
	const fixes = {
		login: "ghcr.io isn't answering. Check your internet connection, then restart dev.",
		docker:
			"Docker isn't answering. Quit and reopen Docker Desktop or OrbStack (or restart your Docker engine), then restart dev.",
		gh: "The GitHub CLI isn't answering. Check your internet connection and `gh auth status`, then restart dev.",
		open: "macOS didn't finish opening the Docker app. Open Docker Desktop or OrbStack yourself, then restart dev.",
		lsof: `Find and stop the program using port ${SYNTAX_AUTH_LOCAL_PORT}, then restart dev.`
	};
	const key = command === 'docker' && args[0] === 'login' ? 'login' : command;
	return {
		timeout_ms: limits.inspect_ms,
		fix: key in fixes ? fixes[/** @type {keyof typeof fixes} */ (key)] : 'Restart dev to try again.'
	};
}

/**
 * `run_command` with a limit on every command (see StartupLimits). A command that stalls is stopped
 * and throws StalledCommand naming it.
 * @param {Run} run_command
 * @param {StartupLimits} [limits]
 * @returns {Run}
 */
export function with_startup_limits(run_command, limits = STARTUP_LIMITS) {
	return async (command, args, options = {}) => {
		const { timeout_ms, fix } = startup_limit(command, args, limits);
		const result = await run_command(command, args, {
			...options,
			timeout_ms,
			kill_grace_ms: limits.kill_grace_ms
		});
		if (!result.timed_out) return result;
		throw new StalledCommand(
			`\`${describe_command(command, args)}\` didn't finish within ${describe_limit(timeout_ms)}, so local Syntax Auth's startup stopped it. ${fix}`
		);
	};
}

/** @param {string[]} args @param {Run} [run_command] */
export function docker(args, run_command = run) {
	return run_command('docker', args);
}

/** @param {{ code: number | null, stderr: string }} result */
export function is_missing_command(result) {
	return result.code === null && result.stderr.includes('ENOENT');
}

/** @param {string} text */
export function first_line(text) {
	return text.split('\n').find((line) => line.trim() !== '') ?? text;
}

/** @param {string} stderr */
function is_access_denied(stderr) {
	return /unauthorized|denied|forbidden/i.test(stderr);
}

/** @param {string} login @param {{ stdout: string, stderr: string }} membership */
function describe_membership_problem(login, membership) {
	if (membership.stdout === 'pending') {
		return `GitHub account ${login} has a pending invite to the syntaxfm org. Accept it at https://github.com/orgs/syntaxfm/invitation, then restart dev.`;
	}
	// gh adds a misleading admin:org hint to a 404, so check the status before any scope.
	if (/HTTP 404/.test(membership.stderr)) {
		return `GitHub account ${login} isn't in the syntaxfm org. If you're on the Syntax team, ask an org owner to add ${login}, then restart dev.`;
	}
	if (/read:org/.test(membership.stderr)) {
		return 'the GitHub CLI needs the read:org scope to check your syntaxfm membership. Run `gh auth refresh -h github.com -s read:org`, then restart dev.';
	}
	return `the GitHub CLI couldn't check your syntaxfm membership: ${first_line(membership.stderr)}`;
}

async function find_docker_binary() {
	for (const directory of (process.env.PATH ?? '').split(delimiter)) {
		const candidate = join(directory, 'docker');
		try {
			await access(candidate, constants.X_OK);
			return candidate;
		} catch {
			// Not in this PATH entry.
		}
	}
	return null;
}

// The image is private to the Syntax team. For a syntaxfm member, pull once with their GitHub CLI
// token in a throwaway Docker config. PATH exposes only the docker binary, so Docker cannot fall
// back to the OS keychain: the token is never saved, and any existing ghcr.io login is untouched.
// Returns why the app runs signed out (`problem`), or the pull's result.
/**
 * @param {Run} run_command
 * @returns {Promise<{ problem: string } | { result: { code: number | null, stdout: string, stderr: string } }>}
 */
async function pull_as_syntax_team_member(run_command) {
	const user = await run_command('gh', ['api', 'user', '--jq', '.login']);
	if (is_missing_command(user)) {
		return {
			problem:
				"downloading it needs the GitHub CLI, which isn't installed. Install it (`brew install gh`, or see https://cli.github.com), run `gh auth login`, then restart dev."
		};
	}
	if (user.code !== 0) {
		return {
			problem: /gh auth login/.test(user.stderr)
				? "downloading it needs the GitHub CLI signed in, and it isn't. Run `gh auth login`, then restart dev."
				: `the GitHub CLI couldn't read your GitHub account: ${first_line(user.stderr)}`
		};
	}

	const membership = await run_command('gh', [
		'api',
		'user/memberships/orgs/syntaxfm',
		'--jq',
		'.state'
	]);
	if (membership.code !== 0 || membership.stdout !== 'active') {
		return { problem: describe_membership_problem(user.stdout, membership) };
	}

	const [token, context, docker_binary] = await Promise.all([
		run_command('gh', ['auth', 'token', '--hostname', 'github.com']),
		docker(['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}'], run_command),
		find_docker_binary()
	]);
	if (token.code !== 0) {
		return { problem: `the GitHub CLI couldn't give a token: ${first_line(token.stderr)}` };
	}
	if (context.code !== 0 || !docker_binary) {
		return {
			problem: `Docker's current context couldn't be read: ${first_line(context.stderr)}`
		};
	}

	const config_directory = await mkdtemp(join(tmpdir(), 'syntax-auth-docker-config-'));
	const binary_directory = await mkdtemp(join(tmpdir(), 'syntax-auth-docker-bin-'));
	try {
		await symlink(docker_binary, join(binary_directory, 'docker'));
		const env = {
			...process.env,
			PATH: binary_directory,
			DOCKER_CONFIG: config_directory,
			DOCKER_HOST: context.stdout
		};
		const login = await run_command(
			'docker',
			['login', 'ghcr.io', '--username', user.stdout, '--password-stdin'],
			{ input: token.stdout, env }
		);
		if (login.code !== 0) return { result: login };
		return { result: await run_command('docker', ['pull', '--quiet', IMAGE], { env }) };
	} finally {
		await rm(config_directory, { recursive: true, force: true });
		await rm(binary_directory, { recursive: true, force: true });
	}
}

/**
 * @param {Run} [run_command]
 * @returns {Promise<string | null>} null once the image is downloaded, otherwise what is wrong.
 */
export async function pull_image(run_command = run) {
	const result = await docker(['pull', '--quiet', IMAGE], run_command);
	if (result.code === 0) return null;
	if (!is_access_denied(result.stderr)) {
		return `local Syntax Auth's Docker image couldn't be downloaded: ${first_line(result.stderr)}`;
	}

	const team_pull = await pull_as_syntax_team_member(run_command);
	if ('problem' in team_pull) {
		return `local Syntax Auth's Docker image is private to the Syntax team, and ${team_pull.problem}`;
	}
	if (team_pull.result.code === 0) return null;

	return is_access_denied(team_pull.result.stderr)
		? "your GitHub CLI token can't read the syntaxfm package registry. Run `gh auth refresh -h github.com -s read:packages`, then restart dev."
		: `local Syntax Auth's Docker image couldn't be downloaded: ${first_line(team_pull.result.stderr)}`;
}

/**
 * @param {Run} [run_command]
 * @returns {Promise<string | null>} the program listening on the local port, like "python3 (pid 123)"
 */
export async function find_port_holder(run_command = run) {
	const result = await run_command('lsof', [
		'-nP',
		`-iTCP:${SYNTAX_AUTH_LOCAL_PORT}`,
		'-sTCP:LISTEN',
		'-Fpc'
	]);
	const pid = result.stdout.match(/^p(\d+)$/m)?.[1];
	const command = result.stdout.match(/^c(.+)$/m)?.[1];
	return pid && command ? `${command} (pid ${pid})` : null;
}

// True only when Syntax Auth itself answers, never another program that happens to use the port.
export async function is_healthy() {
	try {
		// The container and Syntax Auth's own dev server both listen on IPv4 loopback.
		const response = await fetch(`http://127.0.0.1:${SYNTAX_AUTH_LOCAL_PORT}/api/health`, {
			signal: AbortSignal.timeout(5_000)
		});
		const body = await response.json();
		return response.ok && body?.service === 'syntax-auth';
	} catch {
		return false;
	}
}

/**
 * @param {Run} [run_command]
 * @returns {Promise<{ is_running: boolean, image_id: string } | null>}
 */
export async function get_container_state(run_command = run) {
	const result = await docker(
		['container', 'inspect', '--format', '{{.State.Running}} {{.Image}}', CONTAINER_NAME],
		run_command
	);
	if (result.code !== 0) return null;

	const [running, image_id] = result.stdout.split(' ');
	return { is_running: running === 'true', image_id };
}

/**
 * @param {Run} [run_command]
 * @returns {Promise<string | null>} null when the container runs, otherwise why it could not.
 */
export async function create_container(run_command = run) {
	const result = await docker(
		[
			'run',
			'--detach',
			// Forwards stop signals so Syntax Auth's own `pnpm dev` can take the port over immediately.
			'--init',
			'--name',
			CONTAINER_NAME,
			'--restart',
			'unless-stopped',
			'--publish',
			`127.0.0.1:${SYNTAX_AUTH_LOCAL_PORT}:${SYNTAX_AUTH_LOCAL_PORT}`,
			'--volume',
			`${VOLUME_NAME}:/app/.wrangler`,
			IMAGE
		],
		run_command
	);
	return result.code === 0 || result.stderr.includes(NAME_IN_USE) ? null : result.stderr;
}

/** @param {number} port @returns {Promise<import('node:net').Server>} */
function acquire_lock(port) {
	return new Promise((resolve, reject) => {
		const deadline = Date.now() + LOCK_TIMEOUT_MS;

		const attempt = () => {
			const server = createServer();
			server.once('error', (/** @type {NodeJS.ErrnoException} */ error) => {
				if (error.code !== 'EADDRINUSE') return reject(error);
				if (Date.now() > deadline) {
					return reject(
						new Error(
							'Timed out after 5 minutes waiting for another Syntax dev server to finish starting local Syntax Auth'
						)
					);
				}
				setTimeout(attempt, 250);
			});
			server.listen({ host: '127.0.0.1', port, exclusive: true }, () => {
				server.unref();
				resolve(server);
			});
		};

		attempt();
	});
}

/**
 * Runs `task` while no other process on this machine holds the lock on `port`.
 * @template T
 * @param {number} port
 * @param {() => Promise<T>} task
 * @returns {Promise<T>}
 */
export async function with_port_lock(port, task) {
	const lock = await acquire_lock(port);
	try {
		return await task();
	} finally {
		lock.close();
	}
}

/**
 * Runs `task` while no other process on this machine is changing a container.
 * @template T
 * @param {() => Promise<T>} task
 * @returns {Promise<T>}
 */
export function with_container_lock(task) {
	return with_port_lock(CONTAINER_LOCK_PORT, task);
}

/** @param {Run} run_command */
async function is_docker_running(run_command) {
	try {
		return (await run_command('docker', ['info', '--format', '{{.ServerVersion}}'])).code === 0;
	} catch (error) {
		// While Docker starts, a stalled check only means not ready yet; the 2-minute wait decides.
		if (error instanceof StalledCommand) return false;
		throw error;
	}
}

/**
 * How `ensure_docker` opens the Docker app on a Mac.
 * @typedef {object} DockerStartOptions
 * @property {<T>(task: () => Promise<T>) => Promise<T>} lock machine-wide; the container lock
 * @property {NodeJS.Platform} platform
 * @property {string} result_path where the last start's outcome is kept for those that waited
 * @property {number} ready_timeout_ms how long the opened app may take to answer
 * @property {number} poll_ms
 * @property {() => Promise<string | null>} why_not_open null when the Docker app may be opened (a
 *   person is at this Mac's screen); otherwise where this run started, like "from an agent shell
 *   (PI_CODING_AGENT)" (see presence.js). Docker Desktop's first run and its
 *   privileged helper can show dialogs, so nothing opens it where nobody can answer them.
 */
/** @type {Omit<DockerStartOptions, 'why_not_open'>} */
export const DOCKER_START = {
	lock: with_container_lock,
	platform: process.platform,
	result_path: join(tmpdir(), 'syntax-auth-docker-start.json'),
	ready_timeout_ms: DOCKER_START_TIMEOUT_MS,
	poll_ms: 1_000
};

/**
 * The outcome of a start that finished after `since`, or null when there is none.
 * @param {string} path
 * @param {number} since
 * @returns {Promise<{ problem: string | null } | null>}
 */
async function read_start_result(path, since) {
	try {
		const saved = JSON.parse(await readFile(path, 'utf8'));
		if (typeof saved?.finished_at !== 'number' || saved.finished_at < since) return null;
		return { problem: typeof saved.problem === 'string' ? saved.problem : null };
	} catch {
		return null;
	}
}

// On macOS, opens the Docker app that Docker's current context points at, then waits for it.
/**
 * @param {Run} run_command
 * @param {DockerStartOptions} options
 * @returns {Promise<string | null>} null when Docker is ready, otherwise what is wrong.
 */
async function start_docker_app(run_command, { ready_timeout_ms, poll_ms }) {
	const context = await run_command('docker', [
		'context',
		'inspect',
		'--format',
		'{{.Endpoints.docker.Host}}'
	]);
	const apps = context.stdout.includes('orbstack')
		? ['OrbStack', 'Docker Desktop']
		: ['Docker Desktop', 'OrbStack'];

	for (const app of apps) {
		// Docker Desktop can crash its Electron startup when `open --background` is used.
		const opened = await run_command('open', ['-a', app === 'Docker Desktop' ? 'Docker' : app]);
		if (opened.code !== 0) continue;

		log(`Starting ${app}`);
		const deadline = Date.now() + ready_timeout_ms;
		while (Date.now() < deadline) {
			if (await is_docker_running(run_command)) return null;
			await sleep(poll_ms);
		}
		return `${app} was opened, but Docker wasn't ready after ${describe_wait(ready_timeout_ms)}. Check ${app} for an error or a prompt, then restart dev.`;
	}
	return 'Docker is installed but not running, and neither Docker Desktop nor OrbStack is installed to start it. Start your Docker engine, then restart dev.';
}

/**
 * Opens the Docker app at most once at a time on this Mac, so concurrent dev starts don't race.
 * The start runs under the container lock and keeps its outcome, a stalled or
 * failed command included, before letting go of it; an instance that waited for it re-checks
 * Docker, and when the start it waited for failed, gives that start's message instead of opening
 * the app again.
 * @param {Run} run_command
 * @param {DockerStartOptions} options
 * @returns {Promise<string | null>} null when Docker is ready, otherwise what is wrong.
 */
async function start_docker_app_once(run_command, options) {
	const asked_at = Date.now();
	return options.lock(async () => {
		if (await is_docker_running(run_command)) return null;
		const waited_for = await read_start_result(options.result_path, asked_at);
		if (waited_for?.problem) return waited_for.problem;

		/** @param {string | null} problem */
		const keep = (problem) =>
			writeFile(options.result_path, JSON.stringify({ finished_at: Date.now(), problem })).catch(
				() => {
					// Only those waiting read it; without it, the next one opens the app itself.
				}
			);
		try {
			const problem = await start_docker_app(run_command, options);
			await keep(problem);
			return problem;
		} catch (error) {
			await keep(error instanceof Error ? error.message : String(error));
			throw error;
		}
	});
}

/**
 * Docker running, or why not. On a Mac it opens Docker Desktop or OrbStack only when
 * `why_not_open` says a person is at the screen; otherwise it says why it didn't.
 * @param {Run} run_command
 * @param {Partial<DockerStartOptions> & Pick<DockerStartOptions, 'why_not_open'>} start_options see DOCKER_START
 * @returns {Promise<string | null>} null when Docker is ready, otherwise what is wrong.
 */
export async function ensure_docker(run_command, start_options) {
	const options = { ...DOCKER_START, ...start_options };
	const info = await run_command('docker', ['info', '--format', '{{.ServerVersion}}']);
	if (info.code === 0) return null;
	if (is_missing_command(info)) {
		return "Docker isn't installed. Install Docker Desktop (https://www.docker.com/products/docker-desktop/) or OrbStack (https://orbstack.dev), then restart dev.";
	}
	if (/permission denied/i.test(info.stderr)) {
		return `Docker is installed, but your user can't use it (${first_line(info.stderr)}). On Linux, add yourself to the docker group (https://docs.docker.com/engine/install/linux-postinstall/), then restart dev.`;
	}
	if (options.platform === 'darwin') {
		const where = await options.why_not_open();
		if (where) {
			return `Docker isn't running, and this dev server was started ${where}, so it didn't open Docker Desktop or OrbStack. Start Docker Desktop (or OrbStack), then restart dev.`;
		}
		return start_docker_app_once(run_command, options);
	}
	return `Docker is installed but not running (${first_line(info.stderr)}). Start it (for example \`sudo systemctl start docker\`), then restart dev.`;
}
