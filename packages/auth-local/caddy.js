// Finds the Caddy that serves https on this computer, or starts Syntax's own, and adds the
// .syntax.test routes to it through its admin API. Setup changes only a Caddy it has proven: its
// API answers as Caddy's does, and it is either a `caddy` process or Syntax's own container.
import { randomBytes } from 'node:crypto';
import { isIP } from 'node:net';
import { basename } from 'node:path';

import { describe_listeners, find_port_listeners, first_line, sleep } from './container.js';
import { ALLOWED_CLIENT_RANGES, SITE_HOSTNAMES, SYNTAX_TEST_HOSTNAMES } from './names.js';

// The official image, pinned (Caddy 2.11.4).
export const CADDY_IMAGE =
	'caddy@sha256:0c994536bddb66445885237f1a5dcc1916bccea922661c76b4e9fc24061f9b52';
export const CADDY_CONTAINER = 'syntax-caddy';
export const TLS_POLICY_ID = 'syntax-test-tls';
// Answers with the client address Caddy sees, to learn the address Docker forwards from.
export const SOURCE_PATH = '/syntax-caddy-source';
const API_TIMEOUT_MS = 10_000;
const API_START_TIMEOUT_MS = 30_000;
const PORT_IN_USE = /address already in use|port is already allocated|ports are not available/i;

/**
 * @typedef {import('./names.js').SiteName} SiteName
 * @typedef {{ problem: string, fix: string }} Problem
 * @typedef {{ name: SiteName, port: number, routes: { path: string, port: number }[] }} Site
 * @typedef {{ kind: 'native' | 'container', upstream_host: string, client_ranges: string[] }} Caddy
 * @typedef {object} CaddyDeps
 * @property {import('./container.js').Run} run
 * @property {string} admin_origin Caddy's admin API, like http://127.0.0.1:2019
 * @property {number} admin_port
 * @property {number} https_port
 * @property {number} http_port
 * @property {<T>(task: () => Promise<T>) => Promise<T>} container_lock
 * @property {(run: import('./container.js').Run) => Promise<string | null>} ensure_docker
 * @property {string} setup_command the command that runs setup in a terminal
 */

/** @param {SiteName} name */
export function route_id(name) {
	return `syntax-test-${name}`;
}

/**
 * @param {{ admin_origin: string }} deps
 * @param {string} method
 * @param {string} path
 * @param {unknown} [body]
 * @returns {Promise<{ status: number, json: unknown, text: string }>} status 0 when nothing answers
 */
export async function caddy_api(deps, method, path, body) {
	try {
		const response = await fetch(`${deps.admin_origin}${path}`, {
			method,
			headers: body === undefined ? {} : { 'content-type': 'application/json' },
			body: body === undefined ? undefined : JSON.stringify(body),
			signal: AbortSignal.timeout(API_TIMEOUT_MS)
		});
		const text = await response.text();
		let json = null;
		try {
			json = JSON.parse(text);
		} catch {
			// Not JSON; callers that need JSON check for it.
		}
		return { status: response.status, json, text };
	} catch (error) {
		return { status: 0, json: null, text: error instanceof Error ? error.message : String(error) };
	}
}

/** @param {{ json: unknown, text: string }} response */
function api_error(response) {
	const json = /** @type {{ error?: unknown } | null} */ (response.json);
	return typeof json?.error === 'string' ? json.error : first_line(response.text);
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function is_object(value) {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Whether port 2019 answers as Caddy's admin API does: its config is a JSON object, and an unknown
 * `@id` gets Caddy's exact 404.
 * @param {CaddyDeps} deps
 * @returns {Promise<'absent' | 'other' | 'caddy'>}
 */
export async function probe_caddy_api(deps) {
	const config = await caddy_api(deps, 'GET', '/config/');
	if (config.status === 0) return 'absent';
	if (config.status !== 200 || !is_object(config.json)) return 'other';

	const id = `syntax-test-probe-${randomBytes(8).toString('hex')}`;
	const unknown = await caddy_api(deps, 'GET', `/id/${id}`);
	const json = /** @type {{ error?: unknown } | null} */ (unknown.json);
	return unknown.status === 404 && json?.error === `unknown object ID '${id}'` ? 'caddy' : 'other';
}

/**
 * @param {CaddyDeps} deps
 * @returns {Promise<{ running: boolean, image: string, admin_bound_to_loopback: boolean } | null>}
 */
async function inspect_own_container(deps) {
	const result = await deps.run('docker', [
		'container',
		'inspect',
		'--format',
		'{{json .}}',
		CADDY_CONTAINER
	]);
	if (result.code !== 0) return null;
	try {
		const container = JSON.parse(result.stdout);
		/** @type {{ HostIp?: string, HostPort?: string }[]} */
		const bindings = container?.HostConfig?.PortBindings?.['2019/tcp'] ?? [];
		return {
			running: container?.State?.Running === true,
			image: String(container?.Config?.Image ?? ''),
			admin_bound_to_loopback:
				bindings.length > 0 &&
				bindings.every(
					(binding) =>
						binding.HostIp === '127.0.0.1' && binding.HostPort === String(deps.admin_port)
				)
		};
	} catch {
		return null;
	}
}

/**
 * Proves that what answers on port 2019 is Syntax's own Caddy container or a `caddy` process.
 * @param {CaddyDeps} deps
 * @returns {Promise<{ kind: 'native' | 'container' } | Problem>}
 */
async function prove_caddy(deps) {
	const own = await inspect_own_container(deps);
	if (own?.running && own.image === CADDY_IMAGE && own.admin_bound_to_loopback) {
		return { kind: 'container' };
	}

	const listeners = await find_port_listeners(deps.admin_port, deps.run);
	for (const listener of listeners) {
		const command = await deps.run('ps', ['-o', 'comm=', '-p', String(listener.pid)]);
		if (command.code === 0 && basename(command.stdout.trim()) === 'caddy')
			return { kind: 'native' };
	}
	const holder = describe_listeners(listeners) || 'a program setup couldn’t identify';
	return {
		problem: `Port ${deps.admin_port} answers like Caddy's admin API, but it's held by ${holder}, which is neither a caddy process nor Syntax's ${CADDY_CONTAINER} container, so setup won't change it.`,
		fix: `Stop ${holder} so setup can start its own Caddy, or run your Caddy as a caddy process, then restart dev.`
	};
}

/** @param {CaddyDeps} deps @returns {Promise<string[] | Problem>} */
async function find_docker_source_ranges(deps) {
	try {
		const response = await fetch(`http://127.0.0.1:${deps.http_port}${SOURCE_PATH}`, {
			signal: AbortSignal.timeout(API_TIMEOUT_MS)
		});
		const address = (await response.text()).trim();
		const version = isIP(address);
		if (response.ok && version) return [`${address}/${version === 4 ? 32 : 128}`];
		throw new Error(`it answered ${response.status} "${first_line(address)}"`);
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		return {
			problem: `Syntax's Caddy container didn't say which address Docker forwards from (http://127.0.0.1:${deps.http_port}${SOURCE_PATH}: ${reason}), so it can't tell this computer's requests from others.`,
			fix: `Remove the container with \`docker rm --force ${CADDY_CONTAINER}\` (its certificates stay in a volume), then restart dev.`
		};
	}
}

/** @param {CaddyDeps} deps @param {number} port @param {string} holder */
function port_in_use(deps, port, holder) {
	const is_docker = /docker|orbstack|vpnkit/i.test(holder);
	return {
		problem: `Port ${port} is in use by ${holder}, so Syntax's Caddy container can't start there.`,
		fix: is_docker
			? `That is a Docker container: find it with \`docker ps --filter publish=${port}\`, stop it, then restart dev.`
			: `Stop that program, then restart dev. If it's a Caddy, give it an admin API on localhost:${deps.admin_port} and setup will add its routes there instead.`
	};
}

/** @param {CaddyDeps} deps */
function base_config(deps) {
	return {
		admin: {
			listen: '0.0.0.0:2019',
			origins: [`localhost:${deps.admin_port}`, `127.0.0.1:${deps.admin_port}`]
		},
		apps: {
			http: {
				servers: {
					syntax_test: { listen: [':443'], routes: [] },
					syntax_test_source: {
						listen: [':80'],
						routes: [
							{
								match: [{ path: [SOURCE_PATH] }],
								handle: [{ handler: 'static_response', body: '{http.request.remote.host}' }]
							}
						]
					}
				}
			},
			tls: { automation: { policies: [tls_policy()] } },
			pki: { certificate_authorities: { local: { install_trust: false } } }
		}
	};
}

/** @param {CaddyDeps} deps @returns {Promise<Problem | null>} */
async function start_own_caddy(deps) {
	const docker_problem = await deps.ensure_docker(deps.run);
	if (docker_problem) return { problem: docker_problem, fix: '' };

	if ((await deps.run('docker', ['image', 'inspect', CADDY_IMAGE])).code !== 0) {
		const pull = await deps.run('docker', ['pull', '--quiet', CADDY_IMAGE]);
		if (pull.code !== 0) {
			return {
				problem: `Caddy's Docker image couldn't be downloaded: ${first_line(pull.stderr)}`,
				fix: 'Check your internet connection, then restart dev.'
			};
		}
	}

	return deps.container_lock(async () => {
		// Another dev server may have started it while this one waited for the lock.
		if ((await probe_caddy_api(deps)) === 'caddy') return null;

		const own = await inspect_own_container(deps);
		if (!own?.running) {
			for (const port of [deps.https_port, deps.http_port, deps.admin_port]) {
				const listeners = await find_port_listeners(port, deps.run);
				if (listeners.length > 0) return port_in_use(deps, port, describe_listeners(listeners));
			}
		}

		let result;
		if (own && own.image === CADDY_IMAGE && own.admin_bound_to_loopback) {
			result = own.running ? null : await deps.run('docker', ['start', CADDY_CONTAINER]);
		} else {
			if (own) await deps.run('docker', ['rm', '--force', CADDY_CONTAINER]);
			result = await deps.run('docker', [
				'run',
				'--detach',
				'--name',
				CADDY_CONTAINER,
				'--restart',
				'unless-stopped',
				'--publish',
				`127.0.0.1:${deps.https_port}:443`,
				'--publish',
				`127.0.0.1:${deps.http_port}:80`,
				'--publish',
				`127.0.0.1:${deps.admin_port}:2019`,
				'--volume',
				'syntax-caddy-data:/data',
				'--volume',
				'syntax-caddy-config:/config',
				'--env',
				`SYNTAX_CADDY_BASE=${JSON.stringify(base_config(deps))}`,
				'--entrypoint',
				'/bin/sh',
				CADDY_IMAGE,
				'-c',
				// --resume loads the config saved by the last API change, so routes survive restarts.
				'printf "%s" "$SYNTAX_CADDY_BASE" > /etc/caddy/syntax-base.json && exec caddy run --resume --config /etc/caddy/syntax-base.json'
			]);
		}
		if (result && result.code !== 0) {
			if (PORT_IN_USE.test(result.stderr)) {
				const port = Number(
					result.stderr.match(/(?:127\.0\.0\.1:|exposing port TCP [\d.]+:)(\d+)/)?.[1]
				);
				const listeners = port ? await find_port_listeners(port, deps.run) : [];
				return port_in_use(
					deps,
					port || deps.https_port,
					describe_listeners(listeners) || 'another program or container'
				);
			}
			return {
				problem: `Syntax's Caddy container couldn't start: ${first_line(result.stderr)}`,
				fix: `Check \`docker logs ${CADDY_CONTAINER}\`, then restart dev.`
			};
		}

		const deadline = Date.now() + API_START_TIMEOUT_MS;
		while (Date.now() < deadline) {
			if ((await probe_caddy_api(deps)) === 'caddy') return null;
			await sleep(500);
		}
		return {
			problem: `Syntax's Caddy container started, but its admin API didn't answer on localhost:${deps.admin_port} within 30 seconds.`,
			fix: `Check \`docker logs ${CADDY_CONTAINER}\` for the reason, then restart dev.`
		};
	});
}

/**
 * Finds and proves the Caddy to use, starting Syntax's own container when no Caddy runs.
 * @param {CaddyDeps} deps
 * @param {{ can_change: boolean }} options
 * @returns {Promise<{ caddy: Caddy } | Problem>}
 */
export async function find_caddy(deps, { can_change }) {
	const status = await probe_caddy_api(deps);
	if (status === 'other') {
		const holder =
			describe_listeners(await find_port_listeners(deps.admin_port, deps.run)) ||
			'a program setup couldn’t identify';
		return {
			problem: `Port ${deps.admin_port} is in use by ${holder}, which doesn't answer like Caddy's admin API, so setup can't add routes there or start its own Caddy.`,
			fix: `Stop ${holder}, then restart dev.`
		};
	}
	if (status === 'absent') {
		if (!can_change) {
			return {
				problem: `No Caddy answers on localhost:${deps.admin_port}, and setup only checks, never starts one, without a person at this computer's screen.`,
				fix: `Run \`${deps.setup_command}\` in Terminal at this computer's own screen (or over Screen Sharing), then restart dev.`
			};
		}
		const problem = await start_own_caddy(deps);
		if (problem) return problem;
	}

	const proof = await prove_caddy(deps);
	if ('problem' in proof) return proof;
	if (proof.kind === 'native') {
		return {
			caddy: { kind: 'native', upstream_host: 'localhost', client_ranges: ALLOWED_CLIENT_RANGES }
		};
	}
	const source = await find_docker_source_ranges(deps);
	if ('problem' in source) return source;
	return {
		caddy: {
			kind: 'container',
			upstream_host: 'host.docker.internal',
			client_ranges: [...ALLOWED_CLIENT_RANGES, ...source]
		}
	};
}

export function tls_policy() {
	return {
		'@id': TLS_POLICY_ID,
		subjects: SYNTAX_TEST_HOSTNAMES,
		issuers: [{ module: 'internal' }]
	};
}

/**
 * Only this computer and the tailnet reach the app; everyone else gets a 403.
 * @param {Caddy} caddy
 * @param {Site} site
 */
export function site_route(caddy, site) {
	/** @param {number} port */
	const proxy = (port) => ({
		handler: 'reverse_proxy',
		upstreams: [{ dial: `${caddy.upstream_host}:${port}` }]
	});
	return {
		'@id': route_id(site.name),
		match: [{ host: [SITE_HOSTNAMES[site.name]] }],
		handle: [
			{
				handler: 'subroute',
				routes: [
					{
						match: [{ not: [{ client_ip: { ranges: caddy.client_ranges } }] }],
						handle: [
							{
								handler: 'static_response',
								status_code: 403,
								body: 'This Syntax dev server answers only this computer and its tailnet.'
							}
						],
						terminal: true
					},
					...site.routes.map((route) => ({
						match: [{ path: [route.path] }],
						handle: [proxy(route.port)],
						terminal: true
					})),
					{ handle: [proxy(site.port)] }
				]
			}
		],
		terminal: true
	};
}

/** JSON with every object's keys sorted, to compare configs whatever order Caddy keeps them in. */
/** @param {unknown} value @returns {string} */
function canonical(value) {
	if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
	if (is_object(value)) {
		const keys = Object.keys(value).sort();
		return `{${keys.map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
	}
	return JSON.stringify(value);
}

/** @param {unknown} value @returns {string[]} */
function listen_ports(value) {
	if (!Array.isArray(value)) return [];
	return value.map((address) => String(address).split(':').pop() ?? '');
}

/** @param {unknown} route @param {string} hostname */
function route_matches_host(route, hostname) {
	if (!is_object(route) || !Array.isArray(route.match)) return false;
	return route.match.some(
		(matcher) =>
			is_object(matcher) &&
			Array.isArray(matcher.host) &&
			matcher.host.some(
				(host) =>
					host === hostname ||
					(typeof host === 'string' &&
						host.startsWith('*.') &&
						hostname.endsWith(host.slice(1)) &&
						!hostname.slice(0, -host.length + 1).includes('.'))
			)
	);
}

/**
 * Adds or updates the TLS policy and each site's route, leaving every other part of the config
 * alone. Without `can_change`, it only reports what is missing; with `only_missing`, it adds what
 * is missing and leaves an existing policy or route as it is.
 * @param {CaddyDeps} deps
 * @param {Caddy} caddy
 * @param {Site[]} sites
 * @param {{ can_change: boolean, only_missing?: boolean }} options
 * @returns {Promise<{ changed: boolean } | Problem>}
 */
export async function ensure_caddy_config(
	deps,
	caddy,
	sites,
	{ can_change, only_missing = false }
) {
	const config_response = await caddy_api(deps, 'GET', '/config/');
	const config = config_response.json;
	if (config_response.status !== 200 || !is_object(config)) {
		return {
			problem: `Caddy's config couldn't be read from localhost:${deps.admin_port}: ${api_error(config_response)}`,
			fix: 'Restart dev to try again.'
		};
	}
	const apps = is_object(config.apps) ? config.apps : {};
	const http = is_object(apps.http) ? apps.http : {};
	const servers = is_object(http.servers) ? http.servers : {};
	const server_name = Object.keys(servers).find((name) => {
		const server = servers[name];
		return is_object(server) && listen_ports(server.listen).includes('443');
	});
	if (!server_name) {
		return {
			problem: `The Caddy on localhost:${deps.admin_port} has no server listening on port 443, so setup has nowhere to add the https routes.`,
			fix: 'Add any site with a hostname to your Caddy config (that creates the port 443 server), reload Caddy, then restart dev.'
		};
	}
	const server = /** @type {Record<string, unknown>} */ (servers[server_name]);
	const routes = Array.isArray(server.routes) ? server.routes : [];
	const routes_path = `/config/apps/http/servers/${server_name}/routes`;

	/** @type {{ method: string, path: string, body: unknown, what: string }[]} */
	const writes = [];
	if (!('pki' in apps)) {
		// Caddy would otherwise try to trust its own root in the system keychain.
		writes.push({
			method: 'PUT',
			path: '/config/apps/pki',
			body: { certificate_authorities: { local: { install_trust: false } } },
			what: 'its local certificate authority settings'
		});
	}

	const tls = is_object(apps.tls) ? apps.tls : {};
	const automation = is_object(tls.automation) ? tls.automation : {};
	const policies = Array.isArray(automation.policies) ? automation.policies : null;
	const policy = tls_policy();
	const existing_policy = policies?.find(
		(item) => is_object(item) && item['@id'] === TLS_POLICY_ID
	);
	if (!existing_policy) {
		writes.push(
			policies
				? {
						method: 'PUT',
						path: '/config/apps/tls/automation/policies/0',
						body: policy,
						what: 'the .syntax.test certificate policy'
					}
				: {
						method: 'PUT',
						path: '/config/apps/tls/automation/policies',
						body: [policy],
						what: 'the .syntax.test certificate policy'
					}
		);
	} else if (!only_missing && canonical(existing_policy) !== canonical(policy)) {
		writes.push({
			method: 'PATCH',
			path: `/id/${TLS_POLICY_ID}`,
			body: policy,
			what: 'the .syntax.test certificate policy'
		});
	}

	let has_routes = Array.isArray(server.routes);
	for (const site of sites) {
		const hostname = SITE_HOSTNAMES[site.name];
		const id = route_id(site.name);
		const foreign = routes.findIndex(
			(route) => is_object(route) && route['@id'] !== id && route_matches_host(route, hostname)
		);
		if (foreign !== -1) {
			return {
				problem: `Caddy already has a route for ${hostname} that setup didn't add (routes/${foreign} of server ${server_name}), so setup won't take it over.`,
				fix: `Remove that route (or its site block) from your Caddy config, reload Caddy, then restart dev.`
			};
		}

		const route = site_route(caddy, site);
		const existing = routes.find((item) => is_object(item) && item['@id'] === id);
		const what = `the route for ${hostname}`;
		if (!existing) {
			writes.push(
				has_routes
					? { method: 'PUT', path: `${routes_path}/0`, body: route, what }
					: { method: 'PUT', path: routes_path, body: [route], what }
			);
			has_routes = true;
		} else if (!only_missing && canonical(existing) !== canonical(route)) {
			writes.push({ method: 'PATCH', path: `/id/${id}`, body: route, what });
		}
	}

	if (writes.length === 0) return { changed: false };
	if (!can_change) {
		return {
			problem: `Caddy is missing ${new Intl.ListFormat('en').format(writes.map((write) => write.what))}, and setup only checks Caddy, never changes it, without a person at this computer's screen.`,
			fix: `Run \`${deps.setup_command}\` in Terminal at this computer's own screen (or over Screen Sharing), then restart dev.`
		};
	}
	for (const write of writes) {
		const response = await caddy_api(deps, write.method, write.path, write.body);
		if (response.status !== 200) {
			return {
				problem: `Caddy refused ${write.what}: ${api_error(response)}`,
				fix: 'Fix what Caddy names in its config, reload Caddy, then restart dev.'
			};
		}
	}
	return { changed: true };
}

/**
 * Whether Caddy still has the policy and every site's route, by `@id`.
 * @param {{ admin_origin: string }} deps
 * @param {Site[]} sites
 * @returns {Promise<'present' | 'missing' | 'absent'>} absent when the API doesn't answer
 */
export async function check_caddy_ids(deps, sites) {
	const ids = [TLS_POLICY_ID, ...sites.map((site) => route_id(site.name))];
	const responses = await Promise.all(ids.map((id) => caddy_api(deps, 'GET', `/id/${id}`)));
	if (responses.some((response) => response.status === 0)) return 'absent';
	return responses.every((response) => response.status === 200) ? 'present' : 'missing';
}
