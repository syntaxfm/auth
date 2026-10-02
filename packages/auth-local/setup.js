// Makes a Syntax site's https://*.syntax.test name work on this Mac: the hosts file, the Caddy routes,
// and trust in Caddy's root, then checks the name really reaches this dev server. One setup runs at
// a time on the machine, and each step re-checks the real state first, so a second start asks
// nothing and a retry after any failure is safe.
import { lookup } from 'node:dns/promises';
import { request } from 'node:https';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { check_caddy_ids, ensure_caddy_config, find_caddy } from './caddy.js';
import {
	SETUP_LOCK_PORT,
	SYNTAX_AUTH_LOCAL_PORT,
	ensure_docker,
	log,
	run,
	sleep,
	warn,
	with_container_lock,
	with_port_lock
} from './container.js';
import { HOSTS_PATH, describe_elsewhere, ensure_hosts } from './hosts_file.js';
import { SITE_HOSTNAMES, is_loopback_address, site_url } from './names.js';
import { check_served_certificates, ensure_trusted, get_caddy_authority } from './trust.js';

export const STEPS = {
	hosts: 'Hosts file',
	proxy: 'HTTPS proxy (Caddy)',
	certificate: 'Certificate trust',
	check: 'Final check',
	setup: 'Setup'
};

/**
 * @typedef {import('./names.js').SiteName} SiteName
 * @typedef {import('./caddy.js').Site} Site
 * @typedef {import('./caddy.js').Caddy} Caddy
 * @typedef {{ step: string, problem: string, fix: string }} StepProblem
 * @typedef {{ name: SiteName, port?: number, routes?: { path: string, port: number }[], nonce?: string, probe_path?: string }} SetupOptions
 * @typedef {{ sites: Site[], caddy: Caddy, root_pem: string, can_change: boolean }} SetupContext
 * @typedef {{ state: 'worked', problems: [], context: SetupContext } | { state: 'failed', problems: StepProblem[] } | { state: 'unsupported', problems: [] }} SetupResult
 * @typedef {object} SetupDeps
 * @property {import('./container.js').Run} run
 * @property {NodeJS.Platform} platform
 * @property {NodeJS.ProcessEnv} env
 * @property {string} hosts_path
 * @property {boolean} flush_dns
 * @property {string} admin_origin
 * @property {number} admin_port
 * @property {number} https_port
 * @property {number} http_port
 * @property {string} keychain
 * @property {(hostname: string) => Promise<string[]>} lookup
 * @property {<T>(task: () => Promise<T>) => Promise<T>} setup_lock
 * @property {<T>(task: () => Promise<T>) => Promise<T>} container_lock
 * @property {(run: import('./container.js').Run) => Promise<string | null>} ensure_docker
 * @property {(message: string) => void} log
 * @property {(message: string) => void} warn
 * @property {number} recheck_ms
 * @property {number} dialog_timeout_ms
 * @property {number} served_certificate_timeout_ms how long Caddy may take to serve a new certificate
 * @property {number} probe_timeout_ms how long https://<name> may take to reach this dev server
 * @property {number} command_timeout_ms how long any command without its own limit may run
 */

/** @returns {SetupDeps} */
export function default_setup_deps() {
	return {
		run,
		platform: process.platform,
		env: process.env,
		hosts_path: HOSTS_PATH,
		flush_dns: true,
		admin_origin: 'http://127.0.0.1:2019',
		admin_port: 2019,
		https_port: 443,
		http_port: 80,
		keychain: join(homedir(), 'Library', 'Keychains', 'login.keychain-db'),
		lookup: async (hostname) =>
			(await lookup(hostname, { all: true })).map((entry) => entry.address),
		setup_lock: (task) => with_port_lock(SETUP_LOCK_PORT, task),
		container_lock: with_container_lock,
		ensure_docker,
		log,
		warn,
		recheck_ms: 15_000,
		dialog_timeout_ms: 300_000,
		served_certificate_timeout_ms: 15_000,
		probe_timeout_ms: 10_000,
		command_timeout_ms: 30_000
	};
}

/**
 * The terminal command that runs this same setup: the name, its port, and its path routes. Paths
 * are single-quoted so a shell never expands their `*`; check_options and the CLI refuse quotes.
 * @param {SetupOptions} options
 */
export function setup_command({ name, port, routes = [] }) {
	// Syntax Auth's own repository runs the package from its source.
	const command =
		name === 'auth'
			? 'node packages/auth-local/bin.js setup auth'
			: `pnpm exec syntax-auth-local setup ${name}`;
	const port_flag =
		port && !(name === 'auth' && port === SYNTAX_AUTH_LOCAL_PORT) ? [`--port ${port}`] : [];
	const route_flags = routes.map((route) => `--route '${route.path}=${route.port}'`);
	return [command, ...port_flag, ...route_flags].join(' ');
}

/**
 * The deps with a time limit on every command that has none. A command that stalls stops setup
 * with a message naming it; a command with its own limit (a dialog, a download) reports it itself.
 * @template {{ run: import('./container.js').Run, command_timeout_ms: number }} T
 * @param {T} deps
 * @returns {T}
 */
export function with_command_timeouts(deps) {
	const run_command = deps.run;
	return {
		...deps,
		run: async (command, args, options = {}) => {
			if (options.timeout_ms) return run_command(command, args, options);
			const result = await run_command(command, args, {
				...options,
				timeout_ms: deps.command_timeout_ms
			});
			if (result.timed_out) throw new Error(result.stderr);
			return result;
		}
	};
}

/**
 * Whether a person at this Mac's own screen can answer a password or approval dialog.
 * @param {{ run: import('./container.js').Run, env: NodeJS.ProcessEnv }} deps
 */
export async function has_desktop(deps) {
	if (deps.env.SSH_CONNECTION || deps.env.CI) return false;
	const result = await deps.run('launchctl', ['managername']);
	return result.code === 0 && result.stdout.trim() === 'Aqua';
}

/**
 * The app's own site first, then Syntax Auth's, which every start keeps routed.
 * @param {SetupOptions} options
 * @returns {Site[]}
 */
function get_sites({ name, port, routes = [] }) {
	if (name === 'auth') return [{ name, port: port ?? SYNTAX_AUTH_LOCAL_PORT, routes }];
	const auth = { name: /** @type {const} */ ('auth'), port: SYNTAX_AUTH_LOCAL_PORT, routes: [] };
	return port ? [{ name, port, routes }, auth] : [auth];
}

/** @param {StepProblem[]} problems @returns {SetupResult} */
function failed(problems) {
	return { state: 'failed', problems };
}

/**
 * GETs `path` from this computer's port 443 as `hostname`, trusting only Caddy's root.
 * @param {SetupDeps} deps
 * @param {string} hostname
 * @param {string} path
 * @param {string} root_pem
 * @returns {Promise<{ status: number, body: string } | { error: string }>}
 */
function https_get(deps, hostname, path, root_pem) {
	return new Promise((resolve) => {
		const outgoing = request(
			{
				host: '127.0.0.1',
				port: deps.https_port,
				servername: hostname,
				path,
				headers: { host: hostname, accept: 'text/plain' },
				ca: root_pem,
				agent: false,
				timeout: 5_000
			},
			(response) => {
				let body = '';
				response.setEncoding('utf8');
				response.on('data', (chunk) => (body += chunk));
				response.on('end', () => resolve({ status: response.statusCode ?? 0, body }));
				response.on('error', (error) => resolve({ error: error.message }));
			}
		);
		outgoing.on('timeout', () => outgoing.destroy(new Error('no answer within 5 seconds')));
		outgoing.on('error', (error) => resolve({ error: error.message }));
		outgoing.end();
	});
}

/**
 * Whether the names resolve here, Caddy still has the routes, and https://<name> reaches this very
 * dev server (by its nonce).
 * @param {SetupDeps} deps
 * @param {SetupOptions} options
 * @param {SetupContext} context
 * @returns {Promise<StepProblem | null>}
 */
async function check_worked(deps, options, context) {
	for (const site of context.sites) {
		const hostname = SITE_HOSTNAMES[site.name];
		/** @type {string[]} */
		let addresses = [];
		try {
			addresses = await deps.lookup(hostname);
		} catch {
			// Reported below as not resolving.
		}
		if (addresses.length === 0) {
			return {
				step: STEPS.check,
				problem: `${hostname} doesn't resolve on this computer yet, though the hosts file has it.`,
				fix: 'Run `sudo killall -HUP mDNSResponder` to clear macOS’s DNS cache, then restart dev.'
			};
		}
		const other = addresses.filter((address) => !is_loopback_address(address));
		if (other.length > 0) {
			return {
				step: STEPS.check,
				problem: `${hostname} resolves to ${other.join(', ')}, not this computer.`,
				fix: `Check ${deps.hosts_path} and any VPN or DNS profile that answers .test names, then restart dev.`
			};
		}
	}

	if ((await check_caddy_ids(deps, context.sites)) !== 'present') {
		return {
			step: STEPS.check,
			problem: 'Caddy lost the .syntax.test routes right after setup added them.',
			fix: 'Check whether something reloads your Caddy config, then restart dev.'
		};
	}

	if (!options.nonce || !options.probe_path) return null;
	const [site] = context.sites;
	const hostname = SITE_HOSTNAMES[site.name];
	const deadline = Date.now() + deps.probe_timeout_ms;
	for (;;) {
		const answer = await https_get(deps, hostname, options.probe_path, context.root_pem);
		if ('status' in answer && answer.status === 200 && answer.body === options.nonce) return null;
		if (Date.now() > deadline) {
			if ('error' in answer) {
				return {
					step: STEPS.check,
					problem: `https://${hostname} didn't answer through 127.0.0.1:${deps.https_port}: ${answer.error}.`,
					fix: 'Restart dev to try again.'
				};
			}
			if (answer.status === 502) {
				return {
					step: STEPS.check,
					problem: `Caddy couldn't reach this dev server at ${context.caddy.upstream_host}:${site.port}.`,
					fix: `Make sure the dev server listens on 127.0.0.1 port ${site.port} (if it listens on ::1 only, set \`server.host: '127.0.0.1'\` in vite.config), then restart dev.`
				};
			}
			return {
				step: STEPS.check,
				problem: `https://${hostname} answered HTTP ${answer.status}, but not from this dev server.`,
				fix: `Another dev server may hold https://${hostname}: stop it, then restart dev.`
			};
		}
		await sleep(500);
	}
}

/**
 * @param {SetupOptions} options
 * @param {Site[]} sites
 * @param {boolean} can_ask
 * @param {SetupDeps & { setup_command: string }} deps
 * @returns {Promise<SetupResult>}
 */
async function run_steps(options, sites, can_ask, deps) {
	/** @type {StepProblem[]} */
	const problems = [];
	const hostnames = sites.map((site) => SITE_HOSTNAMES[site.name]);

	const hosts = await ensure_hosts({
		run: deps.run,
		hosts_path: deps.hosts_path,
		can_ask,
		setup_command: deps.setup_command,
		flush: deps.flush_dns,
		timeout_ms: deps.dialog_timeout_ms
	});
	if ('problem' in hosts) {
		problems.push({ step: STEPS.hosts, ...hosts });
	} else {
		for (const entry of hosts.elsewhere) {
			const described = describe_elsewhere(entry, deps.hosts_path);
			if (hostnames.includes(entry.hostname)) problems.push({ step: STEPS.hosts, ...described });
			else deps.warn(`${described.problem} ${described.fix}`);
		}
	}
	// With a person here, stop at the first failure so nothing else asks for approval; without
	// one, nothing changes anyway, so report every step that isn't done.
	if (can_ask && problems.length > 0) return failed(problems);

	const found = await find_caddy(deps, { can_change: can_ask });
	if ('problem' in found) return failed([...problems, { step: STEPS.proxy, ...found }]);
	const config = await ensure_caddy_config(deps, found.caddy, sites, { can_change: can_ask });
	if ('problem' in config) return failed([...problems, { step: STEPS.proxy, ...config }]);

	const authority = await get_caddy_authority(deps);
	if ('problem' in authority)
		return failed([...problems, { step: STEPS.certificate, ...authority }]);
	const served = await check_served_certificates(deps, hostnames, authority);
	if ('problem' in served) return failed([...problems, { step: STEPS.certificate, ...served }]);
	const trust = await ensure_trusted(deps, {
		hostname: hostnames[0],
		chain: served.chain,
		root: authority.root,
		can_ask
	});
	if ('problem' in trust) return failed([...problems, { step: STEPS.certificate, ...trust }]);
	if (problems.length > 0) return failed(problems);

	/** @type {SetupContext} */
	const context = {
		sites,
		caddy: found.caddy,
		root_pem: authority.root.toString(),
		can_change: can_ask
	};
	const problem = await check_worked(deps, options, context);
	return problem ? failed([problem]) : { state: 'worked', problems: [], context };
}

/**
 * Sets up `options.name`'s https name. Never throws: an unexpected error becomes a failed step.
 * @param {SetupOptions} options
 * @param {SetupDeps} deps
 * @returns {Promise<SetupResult>}
 */
export async function run_setup(options, deps) {
	if (deps.platform !== 'darwin') return { state: 'unsupported', problems: [] };
	try {
		const step_deps = { ...with_command_timeouts(deps), setup_command: setup_command(options) };
		const can_ask = await has_desktop(step_deps);
		const sites = get_sites(options);
		return await deps.setup_lock(() => run_steps(options, sites, can_ask, step_deps));
	} catch (error) {
		return failed([unexpected(error)]);
	}
}

/** @param {unknown} error @returns {StepProblem} */
function unexpected(error) {
	return {
		step: STEPS.setup,
		problem: `Setup stopped: ${(error instanceof Error ? error.message : String(error)).replace(/\.?$/, '.')}`,
		fix: 'Restart dev to try again.'
	};
}

/**
 * Re-checks a working setup. When Caddy has lost the routes (a restart or `caddy reload`), proves it
 * again and adds back only what is missing, so two dev servers for one name never take turns
 * rewriting its route; the final check then reports which one the name reaches.
 * @param {SetupOptions} options
 * @param {SetupContext} context
 * @param {SetupDeps} deps
 * @returns {Promise<SetupResult>}
 */
export async function recheck(options, context, deps) {
	try {
		const status = await check_caddy_ids(deps, context.sites);
		if (status === 'absent') {
			return failed([
				{
					step: STEPS.proxy,
					problem: `Caddy stopped answering on localhost:${deps.admin_port}, so ${site_url(options.name)} stopped working.`,
					fix: 'Start Caddy again, or restart dev to have setup start it.'
				}
			]);
		}
		if (status === 'present') {
			const problem = await check_worked(deps, options, context);
			return problem ? failed([problem]) : { state: 'worked', problems: [], context };
		}
		const step_deps = { ...with_command_timeouts(deps), setup_command: setup_command(options) };
		return await deps.setup_lock(async () => {
			const found = await find_caddy(step_deps, { can_change: false });
			if ('problem' in found) return failed([{ step: STEPS.proxy, ...found }]);
			const config = await ensure_caddy_config(step_deps, found.caddy, context.sites, {
				can_change: context.can_change,
				only_missing: true
			});
			if ('problem' in config) return failed([{ step: STEPS.proxy, ...config }]);
			if (config.changed) {
				deps.log(
					'Caddy had lost the .syntax.test routes (it restarted or reloaded its config), so setup added them again.'
				);
			}
			const updated = { ...context, caddy: found.caddy };
			const problem = await check_worked(deps, options, updated);
			return problem ? failed([problem]) : { state: 'worked', problems: [], context: updated };
		});
	} catch (error) {
		return failed([unexpected(error)]);
	}
}

/**
 * Re-checks every `deps.recheck_ms` while the dev server runs.
 * @param {SetupOptions} options
 * @param {SetupContext} context
 * @param {SetupDeps} deps
 * @param {(result: SetupResult) => void} on_change
 * @returns {() => void} stops re-checking
 */
export function start_recheck(options, context, deps, on_change) {
	/** @type {SetupResult['state']} */
	let state = 'worked';
	let reported = '[]';
	let latest = context;
	let is_running = false;
	const timer = setInterval(async () => {
		if (is_running) return;
		is_running = true;
		const result = await recheck(options, latest, deps);
		is_running = false;
		if (result.state === 'worked') latest = result.context;
		// Reports only a change, so a lasting problem isn't repeated every few seconds.
		const key = JSON.stringify(result.problems);
		if (result.state !== state || key !== reported) on_change(result);
		state = result.state;
		reported = key;
	}, deps.recheck_ms);
	timer.unref();
	return () => clearInterval(timer);
}

/**
 * The console lines for a setup result.
 * @param {SetupOptions} options
 * @param {SetupResult} result
 * @param {number | undefined} port the dev server's localhost port
 * @returns {string[]}
 */
export function describe_result(options, result, port) {
	const url = site_url(options.name);
	const localhost = port ? `http://localhost:${port}` : 'http://localhost';
	if (result.state === 'unsupported') {
		return [`Automatic setup of ${url} is macOS-only for now; keep using ${localhost}.`];
	}
	if (result.state === 'worked') return [`${url} is ready.`];
	return [
		`${url} isn't working yet, so keep using ${localhost} for now.`,
		...result.problems.map(
			(problem) => `${problem.step}: ${problem.problem}${problem.fix ? ` Fix: ${problem.fix}` : ''}`
		)
	];
}
