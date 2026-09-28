// Docker and locking internals shared by the dev-server entry (index.js) and the detached updater.
import { spawn } from 'node:child_process';
import { access, constants, mkdtemp, rm, symlink } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

export const SYNTAX_AUTH_LOCAL_PORT = 37960;
export const SYNTAX_AUTH_LOCAL_ORIGIN = `http://localhost:${SYNTAX_AUTH_LOCAL_PORT}`;
export const CONTAINER_NAME = 'syntax-auth';
export const IMAGE = 'ghcr.io/syntaxfm/auth-local:latest';

// Holding this port is the machine-wide lock for changing the container. The OS releases it the
// moment the holder exits, so a crashed or interrupted process can never leave a stale lock.
const LOCK_PORT = 37961;
const LOCK_TIMEOUT_MS = 300_000;
const VOLUME_NAME = 'syntax-auth';
const NAME_IN_USE = 'is already in use';

export function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

export function log(message) {
	console.log(`[syntax-auth] ${message}`);
}

export function warn(message) {
	console.warn(`[syntax-auth] ${message}`);
}

/**
 * @param {string} command
 * @param {string[]} args
 * @param {{ input?: string, env?: NodeJS.ProcessEnv }} [options]
 * @returns {Promise<{ code: number | null, stdout: string, stderr: string }>}
 */
function run(command, args, { input, env } = {}) {
	return new Promise((resolve) => {
		const child = spawn(command, args, {
			env: env ?? process.env,
			stdio: ['pipe', 'pipe', 'pipe']
		});
		let stdout = '';
		let stderr = '';
		child.stdout.on('data', (chunk) => (stdout += chunk));
		child.stderr.on('data', (chunk) => (stderr += chunk));
		child.on('error', (error) => resolve({ code: null, stdout, stderr: error.message }));
		child.on('close', (code) => resolve({ code, stdout: stdout.trim(), stderr: stderr.trim() }));
		child.stdin.end(input);
	});
}

/** @param {string[]} args */
export function docker(args) {
	return run('docker', args);
}

function is_access_denied(stderr) {
	return /unauthorized|denied|forbidden/i.test(stderr);
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
/** @returns {Promise<{ code: number | null, stdout: string, stderr: string } | null>} */
async function pull_as_syntax_team_member() {
	const membership = await run('gh', ['api', 'user/memberships/orgs/syntaxfm', '--jq', '.state']);
	if (membership.code !== 0 || membership.stdout !== 'active') return null;

	const [user, token, context, docker_binary] = await Promise.all([
		run('gh', ['api', 'user', '--jq', '.login']),
		run('gh', ['auth', 'token', '--hostname', 'github.com']),
		docker(['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}']),
		find_docker_binary()
	]);
	if (user.code !== 0 || token.code !== 0 || context.code !== 0 || !docker_binary) return null;

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
		const login = await run(
			'docker',
			['login', 'ghcr.io', '--username', user.stdout, '--password-stdin'],
			{ input: token.stdout, env }
		);
		if (login.code !== 0) return login;
		return await run('docker', ['pull', '--quiet', IMAGE], { env });
	} finally {
		await rm(config_directory, { recursive: true, force: true });
		await rm(binary_directory, { recursive: true, force: true });
	}
}

/**
 * @returns {Promise<{ error: string | null, access_problem: 'not_syntax_team' | 'missing_read_packages' | null }>}
 */
export async function pull_image() {
	const result = await docker(['pull', '--quiet', IMAGE]);
	if (result.code === 0) return { error: null, access_problem: null };
	if (!is_access_denied(result.stderr)) return { error: result.stderr, access_problem: null };

	const team_result = await pull_as_syntax_team_member();
	if (!team_result) return { error: result.stderr, access_problem: 'not_syntax_team' };
	if (team_result.code === 0) return { error: null, access_problem: null };

	return is_access_denied(team_result.stderr)
		? { error: team_result.stderr, access_problem: 'missing_read_packages' }
		: { error: team_result.stderr, access_problem: null };
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

/** @returns {Promise<{ is_running: boolean, image_id: string } | null>} */
export async function get_container_state() {
	const result = await docker([
		'container',
		'inspect',
		'--format',
		'{{.State.Running}} {{.Image}}',
		CONTAINER_NAME
	]);
	if (result.code !== 0) return null;

	const [running, image_id] = result.stdout.split(' ');
	return { is_running: running === 'true', image_id };
}

/** @returns {Promise<string | null>} null when the container runs, otherwise why it could not. */
export async function create_container() {
	const result = await docker([
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
	]);
	return result.code === 0 || result.stderr.includes(NAME_IN_USE) ? null : result.stderr;
}

function acquire_lock() {
	return new Promise((resolve, reject) => {
		const deadline = Date.now() + LOCK_TIMEOUT_MS;

		const attempt = () => {
			const server = createServer();
			server.once('error', (error) => {
				if (error.code !== 'EADDRINUSE') return reject(error);
				if (Date.now() > deadline) {
					return reject(new Error('Timed out waiting for another Syntax app to start auth'));
				}
				setTimeout(attempt, 250);
			});
			server.listen({ host: '127.0.0.1', port: LOCK_PORT, exclusive: true }, () => {
				server.unref();
				resolve(server);
			});
		};

		attempt();
	});
}

/**
 * Runs `task` while no other process on this machine is changing the container.
 * @template T
 * @param {() => Promise<T>} task
 * @returns {Promise<T>}
 */
export async function with_container_lock(task) {
	const lock = await acquire_lock();
	try {
		return await task();
	} finally {
		lock.close();
	}
}
