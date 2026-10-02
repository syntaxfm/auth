// Docker, process, and locking internals shared by the dev-server entry (index.js), the .syntax.test
// setup (setup.js), and the detached updater.
import { spawn } from 'node:child_process';
import { access, constants, mkdtemp, rm, symlink } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, delimiter, join } from 'node:path';

export const SYNTAX_AUTH_LOCAL_PORT = 37960;
export const SYNTAX_AUTH_LOCAL_ORIGIN = `http://localhost:${SYNTAX_AUTH_LOCAL_PORT}`;
export const CONTAINER_NAME = 'syntax-auth';
export const IMAGE = 'ghcr.io/syntaxfm/auth-local:latest';

// Holding one of these ports is a machine-wide lock: 37961 for changing a container, 37962 for the
// .syntax.test setup. The OS releases it the moment the holder exits, so a crashed or interrupted
// process can never leave a stale lock.
export const CONTAINER_LOCK_PORT = 37961;
export const SETUP_LOCK_PORT = 37962;
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
	const seconds = Math.round(timeout_ms / 1_000);
	const limit =
		timeout_ms >= 1_000 ? `${seconds} ${seconds === 1 ? 'second' : 'seconds'}` : `${timeout_ms} ms`;
	return `\`${describe_command(command, args)}\` didn't finish within ${limit}, so setup stopped it`;
}

/**
 * Runs a command to completion. Never throws: a missing command gives code null and its error. A
 * command still running after `timeout_ms` gets SIGTERM, then SIGKILL after `kill_grace_ms`, and
 * gives `timed_out: true` with a stderr that names the command.
 * @type {Run}
 */
export function run(command, args, { input, env, timeout_ms, kill_grace_ms = KILL_GRACE_MS } = {}) {
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
 * @typedef {{ proto: string, address: string, process: string, pid: number }} Listener
 */

/**
 * Every TCP listener on `port`, from macOS's `netstat -anv`, which (unlike `lsof`) also shows
 * processes owned by other users, such as a Caddy run by root. Columns are found by the header,
 * which differs between macOS versions: newer ones name the process (`process:pid`, where the name
 * may contain spaces), older ones give only the `pid`, whose name comes from `ps`. A failed or
 * unreadable netstat gives `error`, never an empty list, so a busy port is never taken for free.
 * @param {number} port
 * @param {Run} [run_command]
 * @returns {Promise<{ listeners: Listener[] } | { error: string }>}
 */
export async function find_port_listeners(port, run_command = run) {
	const result = await run_command('netstat', ['-anv', '-p', 'tcp']);
	if (result.code !== 0) {
		return {
			error: `\`netstat -anv -p tcp\` failed: ${first_line(result.stderr) || `exit code ${result.code}`}`
		};
	}
	const lines = result.stdout.split('\n');
	const header_index = lines.findIndex((line) => /^Proto\s/.test(line));
	const header = (lines[header_index] ?? '')
		.replace('Local Address', 'Local_Address')
		.replace('Foreign Address', 'Foreign_Address')
		.trim()
		.split(/\s+/);
	const columns = {
		proto: header.indexOf('Proto'),
		local: header.indexOf('Local_Address'),
		state: header.indexOf('(state)'),
		named: header.indexOf('process:pid'),
		pid: header.indexOf('pid')
	};
	if (
		header_index === -1 ||
		columns.proto !== 0 ||
		columns.local === -1 ||
		columns.state === -1 ||
		(columns.named === -1 && columns.pid === -1)
	) {
		return {
			error: `\`netstat -anv -p tcp\` printed a format setup can't read (no "Proto … Local Address … process:pid" or "pid" header)`
		};
	}

	/** @type {Listener[]} */
	const listeners = [];
	for (const line of lines.slice(header_index + 1)) {
		const fields = line.trim().split(/\s+/);
		if (!/^tcp(?:4|6|46)$/.test(fields[0] ?? '') || fields[columns.state] !== 'LISTEN') continue;
		const local = fields[columns.local] ?? '';
		const dot = local.lastIndexOf('.');
		if (Number(local.slice(dot + 1)) !== port) continue;

		let name = '';
		/** @type {number} */
		let pid;
		if (columns.named !== -1) {
			// The process name may contain spaces: it runs until the field that ends in ":<pid>".
			const end = fields.findIndex((field, i) => i >= columns.named && /:\d+$/.test(field));
			const joined = end === -1 ? '' : fields.slice(columns.named, end + 1).join(' ');
			name = joined.replace(/:\d+$/, '');
			pid = Number(joined.match(/:(\d+)$/)?.[1]);
		} else {
			pid = Number(fields[columns.pid]);
		}
		if (!Number.isInteger(pid) || pid <= 0) {
			return {
				error: `\`netstat -anv -p tcp\` printed a listener on port ${port} without a process id`
			};
		}
		if (!name) {
			const command = await run_command('ps', ['-o', 'comm=', '-p', String(pid)]);
			name = command.code === 0 ? basename(command.stdout.trim()) : '';
		}
		listeners.push({
			proto: fields[0],
			address: local.slice(0, dot),
			process: name || 'a program',
			pid
		});
	}
	return { listeners };
}

/**
 * @param {{ process: string, pid: number }[]} listeners
 * @returns {string} like "nginx (pid 123)" or "nginx (pid 123) and caddy (pid 456)"
 */
export function describe_listeners(listeners) {
	const names = [
		...new Set(listeners.map((listener) => `${listener.process} (pid ${listener.pid})`))
	];
	return names.join(' and ');
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
			server.once('error', (error) => {
				if (error.code !== 'EADDRINUSE') return reject(error);
				if (Date.now() > deadline) {
					return reject(
						new Error(
							'Timed out after 5 minutes waiting for another Syntax dev server to finish its setup'
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
	return (await run_command('docker', ['info', '--format', '{{.ServerVersion}}'])).code === 0;
}

// On macOS, opens the Docker app that Docker's current context points at, then waits for it.
/**
 * @param {Run} run_command
 * @returns {Promise<string | null>} null when Docker is ready, otherwise what is wrong.
 */
async function start_docker_app(run_command) {
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
		const opened = await run_command('open', [
			'--background',
			'-a',
			app === 'Docker Desktop' ? 'Docker' : app
		]);
		if (opened.code !== 0) continue;

		log(`Starting ${app}`);
		const deadline = Date.now() + DOCKER_START_TIMEOUT_MS;
		while (Date.now() < deadline) {
			if (await is_docker_running(run_command)) return null;
			await sleep(1_000);
		}
		return `${app} was opened, but Docker wasn't ready after 2 minutes. Check ${app} for an error or a prompt, then restart dev.`;
	}
	return 'Docker is installed but not running, and neither Docker Desktop nor OrbStack is installed to start it. Start your Docker engine, then restart dev.';
}

/**
 * @param {Run} [run_command]
 * @returns {Promise<string | null>} null when Docker is ready, otherwise what is wrong.
 */
export async function ensure_docker(run_command = run) {
	const info = await run_command('docker', ['info', '--format', '{{.ServerVersion}}']);
	if (info.code === 0) return null;
	if (is_missing_command(info)) {
		return "Docker isn't installed. Install Docker Desktop (https://www.docker.com/products/docker-desktop/) or OrbStack (https://orbstack.dev), then restart dev.";
	}
	if (/permission denied/i.test(info.stderr)) {
		return `Docker is installed, but your user can't use it (${first_line(info.stderr)}). On Linux, add yourself to the docker group (https://docs.docker.com/engine/install/linux-postinstall/), then restart dev.`;
	}
	if (process.platform === 'darwin') return start_docker_app(run_command);
	return `Docker is installed but not running (${first_line(info.stderr)}). Start it (for example \`sudo systemctl start docker\`), then restart dev.`;
}
