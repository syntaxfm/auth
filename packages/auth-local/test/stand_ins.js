// Stand-ins for everything setup touches outside Node: Caddy (its admin API, and its https listener,
// which routes requests the way Caddy's config says), docker, sudo's password dialog (osascript,
// which runs the real hosts script on a temporary file), macOS's `security`, netstat, ps, and
// launchctl. Setup runs unchanged against them through its `deps`.
import { X509Certificate } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer as create_http_server, request as http_request } from 'node:http';
import { createServer as create_https_server } from 'node:https';
import { BlockList, createServer as create_net_server, isIP } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ensure_docker, run as real_run, stall_message, with_port_lock } from '../container.js';
import { why_not_open } from '../setup.js';

const FIXTURES = new URL('./fixtures/', import.meta.url);
/** @param {string} name */
export const fixture = (name) => readFile(new URL(name, FIXTURES), 'utf8');

export const ROOT_PEM = await fixture('root.crt');
export const INTERMEDIATE_PEM = await fixture('intermediate.crt');
export const LEAF_PEM = await fixture('leaf.crt');
export const LEAF_KEY = await fixture('leaf.key');
export const OTHER_ROOT_PEM = await fixture('other_root.crt');
export const ROOT_SHA1 = new X509Certificate(ROOT_PEM).fingerprint.replaceAll(':', '');
export const DOCKER_GATEWAY = '192.168.65.1';
export const SYSTEM_HOSTS = `##
# Host Database
##
127.0.0.1	localhost
255.255.255.255	broadcasthost
::1             localhost
10.1.2.3 nas.home # the NAS
`;

/** @returns {Promise<number>} a port nothing listens on */
export function free_port() {
	return new Promise((resolve) => {
		const server = create_net_server();
		server.listen(0, '127.0.0.1', () => {
			const address = /** @type {import('node:net').AddressInfo} */ (server.address());
			server.close(() => resolve(address.port));
		});
	});
}

/** @param {import('node:http').Server} server @returns {Promise<number>} */
function listen(server) {
	return new Promise((resolve) => {
		server.listen(0, '127.0.0.1', () => {
			resolve(/** @type {import('node:net').AddressInfo} */ (server.address()).port);
		});
	});
}

/** @param {import('node:http').Server} server @param {number} port */
function listen_on(server, port) {
	return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(undefined)));
}

/**
 * @typedef {{ host?: string[], path?: string[], client_ip?: { ranges: string[] }, not?: Matcher[] }} Matcher
 * @typedef {{ handler: string, routes?: Route[], status_code?: number, body?: string, upstreams?: { dial: string }[] }} Handler
 * @typedef {{ match?: Matcher[], handle?: Handler[], terminal?: boolean }} Route
 * @typedef {{ apps?: { http?: { servers?: Record<string, { listen?: string[], routes?: Route[] }> } } }} Config
 */

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function is_object(value) {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** @param {unknown} value @param {string} path @param {Map<string, string>} index */
function index_ids(value, path, index) {
	if (Array.isArray(value)) value.forEach((item, i) => index_ids(item, `${path}/${i}`, index));
	if (!is_object(value)) return;
	if (typeof value['@id'] === 'string') index.set(value['@id'], path);
	for (const [key, item] of Object.entries(value)) index_ids(item, `${path}/${key}`, index);
}

/**
 * Caddy's config traversal (admin.go's unsyncedConfigAccess) for GET, POST, PUT, PATCH, DELETE.
 * @param {{ value: Record<string, unknown> }} holder
 * @param {string} method
 * @param {string[]} parts
 * @param {unknown} body
 * @returns {{ status: number, json?: unknown }}
 */
function access(holder, method, parts, body) {
	if (parts.length === 0) {
		return method === 'GET'
			? { status: 200, json: holder.value }
			: { status: 400, json: { error: 'no traversable path' } };
	}
	/** @type {unknown} */
	let pointer = holder.value;
	for (const [i, part] of parts.entries()) {
		if (is_object(pointer)) {
			const child = pointer[part];
			if (Array.isArray(child) && i === parts.length - 2) {
				const array = child;
				const index = Number(parts[parts.length - 1]);
				if (method === 'POST') array.push(body);
				else if (method === 'GET') return { status: 200, json: array[index] };
				else if (method === 'PUT') array.splice(index, 0, body);
				else if (method === 'PATCH') array[index] = body;
				else if (method === 'DELETE') array.splice(index, 1);
				return { status: 200 };
			}
			if (i === parts.length - 1) {
				if (method === 'GET') return { status: 200, json: pointer[part] ?? null };
				if (method === 'PUT' && part in pointer) {
					return { status: 409, json: { error: `key already exists: ${part}` } };
				}
				if ((method === 'PATCH' || method === 'DELETE') && !(part in pointer)) {
					return { status: 404, json: { error: `key does not exist: ${part}` } };
				}
				if (method === 'DELETE') delete pointer[part];
				else if (method === 'POST' && Array.isArray(child)) child.push(body);
				else pointer[part] = body;
				return { status: 200 };
			}
			if (pointer[part] == null && method === 'PUT') pointer[part] = {};
			pointer = pointer[part];
		} else if (Array.isArray(pointer)) {
			pointer = pointer[Number(part)];
		} else {
			return { status: 500, json: { error: `invalid traversal path at: ${parts.join('/')}` } };
		}
	}
	return { status: 500, json: { error: 'unreachable' } };
}

/** A Caddy config like Scott's: a site on port 443 that isn't ours. */
export function existing_caddy_config() {
	return {
		apps: {
			http: {
				servers: {
					srv0: {
						listen: [':443'],
						routes: [
							{
								match: [{ host: ['robo.online'] }],
								handle: [{ handler: 'static_response', body: 'robo.online' }],
								terminal: true
							}
						]
					}
				}
			}
		}
	};
}

/**
 * Caddy's admin API, or (with `imitation`) something that answers its config path but isn't Caddy.
 * @param {{ config?: unknown, port?: number, imitation?: boolean, root_pem?: string }} [options]
 */
export async function start_fake_caddy({
	config = existing_caddy_config(),
	port,
	imitation = false,
	root_pem = ROOT_PEM
} = {}) {
	const initial = JSON.stringify(config);
	/** @type {{ value: Record<string, unknown> }} */
	const holder = { value: JSON.parse(initial) };
	/** @type {string[]} */
	const writes = [];
	/** @type {{ method: string, path: string, headers: import('node:http').IncomingHttpHeaders }[]} */
	const requests = [];
	const server = create_http_server(async (request, response) => {
		requests.push({
			method: request.method ?? 'GET',
			path: request.url ?? '/',
			headers: request.headers
		});
		// Caddy 2.11.4 admin.go: browser headers trigger origin checking even without enforce_origin.
		const admin = is_object(holder.value.admin) ? holder.value.admin : {};
		const origin = request.headers.origin ?? '';
		const origins = Array.isArray(admin.origins) ? admin.origins : [];
		const has_browser_headers = 'origin' in request.headers || 'sec-fetch-mode' in request.headers;
		if (
			(admin.enforce_origin || has_browser_headers) &&
			!origins.some((allowed) => {
				if (typeof allowed !== 'string' || !origin) return false;
				const url = new URL(allowed.includes('://') ? allowed : `http://${allowed}`);
				try {
					const from = new URL(origin);
					return (
						from.host === url.host && (!allowed.includes('://') || from.protocol === url.protocol)
					);
				} catch {
					return false;
				}
			})
		) {
			response.writeHead(403, { 'content-type': 'application/json' });
			response.end(
				JSON.stringify({ error: `client is not allowed to access from origin '${origin}'` })
			);
			return;
		}
		let text = '';
		for await (const chunk of request) text += chunk;
		const body = text ? JSON.parse(text) : undefined;
		const url = new URL(request.url ?? '/', 'http://caddy');
		const method = request.method ?? 'GET';
		/** @type {{ status: number, json?: unknown }} */
		let result;
		if (url.pathname === '/pki/ca/local') {
			result = {
				status: 200,
				json: {
					id: 'local',
					root_certificate: root_pem,
					intermediate_certificate: INTERMEDIATE_PEM
				}
			};
		} else if (url.pathname.startsWith('/id/')) {
			const [, , id, ...rest] = url.pathname.split('/');
			const index = new Map();
			index_ids(holder.value, '', index);
			if (imitation) result = { status: 404, json: { error: 'not found' } };
			else if (!index.has(id))
				result = { status: 404, json: { error: `unknown object ID '${id}'` } };
			else {
				const parts = `${index.get(id)}/${rest.join('/')}`.split('/').filter(Boolean);
				result = access(holder, method, parts, body);
			}
		} else if (url.pathname.startsWith('/config')) {
			const parts = url.pathname
				.replace(/^\/config\/?/, '')
				.split('/')
				.filter(Boolean);
			result = access(holder, method, parts, body);
		} else {
			result = { status: 404, json: { error: 'not found' } };
		}
		if (method !== 'GET') writes.push(`${method} ${url.pathname}`);
		response.writeHead(result.status, { 'content-type': 'application/json' });
		response.end(result.json === undefined ? '' : JSON.stringify(result.json));
	});
	const admin_port = port ?? (await listen(server));
	if (port) await listen_on(server, port);
	return {
		admin_port,
		origin: `http://127.0.0.1:${admin_port}`,
		writes,
		requests,
		/** @returns {Config} */
		get config() {
			return holder.value;
		},
		// Like `caddy reload` from a Caddyfile: the API's changes are gone.
		reload() {
			holder.value = JSON.parse(initial);
		},
		close: () => new Promise((resolve) => server.close(resolve))
	};
}

/** @param {Matcher} matcher @param {{ host: string, path: string, client: string }} request */
function matches(matcher, request) {
	if (matcher.host && !matcher.host.includes(request.host)) return false;
	if (
		matcher.path &&
		!matcher.path.some((path) =>
			path.endsWith('*') ? request.path.startsWith(path.slice(0, -1)) : path === request.path
		)
	) {
		return false;
	}
	if (matcher.client_ip) {
		const list = new BlockList();
		for (const range of matcher.client_ip.ranges) {
			const [address, prefix] = range.split('/');
			list.addSubnet(address, Number(prefix), isIP(address) === 6 ? 'ipv6' : 'ipv4');
		}
		if (!list.check(request.client, isIP(request.client) === 6 ? 'ipv6' : 'ipv4')) return false;
	}
	if (matcher.not && matcher.not.some((inner) => matches(inner, request))) {
		return false;
	}
	return true;
}

/**
 * Caddy's route evaluation for the handlers setup uses: the first matching route's handlers answer.
 * @param {Route[]} routes
 * @param {{ host: string, path: string, client: string }} request
 * @returns {{ status: number, body: string } | { dial: string } | null}
 */
export function evaluate_routes(routes, request) {
	for (const route of routes) {
		if (route.match && !route.match.some((set) => matches(set, request))) {
			continue;
		}
		for (const handler of route.handle ?? []) {
			if (handler.handler === 'subroute') {
				const result = evaluate_routes(handler.routes ?? [], request);
				if (result) return result;
			}
			if (handler.handler === 'static_response') {
				return { status: Number(handler.status_code ?? 200), body: handler.body ?? '' };
			}
			if (handler.handler === 'reverse_proxy') return { dial: handler.upstreams?.[0]?.dial ?? '' };
		}
		if (route.terminal) return null;
	}
	return null;
}

/**
 * Caddy's https listener: serves the fixture site certificate and answers as the fake Caddy's
 * port 443 server's routes say. `client` is the address Caddy sees the request coming from.
 * @param {{ config: Config | undefined }} caddy
 */
export async function start_fake_https(caddy) {
	const front = { client: '127.0.0.1' };
	const server = create_https_server(
		{ key: LEAF_KEY, cert: `${LEAF_PEM}${INTERMEDIATE_PEM}` },
		(request, response) => {
			const servers = Object.values(caddy.config?.apps?.http?.servers ?? {});
			const https = servers.find((item) => item.listen?.includes(':443'));
			const result = evaluate_routes(https?.routes ?? [], {
				host: (request.headers.host ?? '').split(':')[0],
				path: new URL(request.url ?? '/', 'https://caddy').pathname,
				client: front.client
			});
			if (!result) return void response.end();
			if ('status' in result) {
				response.writeHead(result.status);
				return void response.end(result.body);
			}
			const port = Number(result.dial.split(':').pop());
			const upstream = http_request(
				{
					host: '127.0.0.1',
					port,
					path: request.url,
					method: request.method,
					headers: request.headers
				},
				(answer) => {
					response.writeHead(answer.statusCode ?? 502, answer.headers);
					answer.pipe(response);
				}
			);
			upstream.on('error', () => {
				response.writeHead(502);
				response.end();
			});
			request.pipe(upstream);
		}
	);
	const port = await listen(server);
	return Object.assign(front, {
		port,
		close: () => new Promise((resolve) => server.close(resolve))
	});
}

/**
 * The commands setup runs, as on a Mac. Each test changes `state` to set the scene and reads
 * `calls` to see what ran.
 */
export function create_run() {
	const state = {
		desktop: 'Aqua',
		/** @type {'approve' | 'cancel' | 'timeout'} */
		hosts_answer: 'approve',
		/** @type {'approve' | 'cancel'} */
		trust_answer: 'approve',
		/** @type {Map<number, { proto?: string, address: string, process: string, pid: number }[]>} */
		listeners: new Map(),
		/** How netstat prints: `named` (macOS 13 and later, process:pid) or `numeric` (pid only). */
		/** @type {'named' | 'numeric' | 'fails'} */
		netstat: 'named',
		/** Commands that hang until their time limit, like "docker info". */
		/** @type {Set<string>} */
		stalls: new Set(),
		/** Runs while the password dialog is open, before the hosts script. */
		/** @type {() => Promise<void>} */
		while_dialog_open: async () => {},
		/** @type {Map<number, string>} */
		processes: new Map(),
		keychain: { certificates: new Set(), trusted: new Set() },
		docker_installed: true,
		/** Whether the Docker engine answers `docker info`. */
		docker_running: true,
		/** @type {null | { running: boolean, image: string, admin_port: number }} */
		container: null,
		/** @type {(args: string[]) => Promise<{ code: number | null, stdout: string, stderr: string }>} */
		docker_run: async () => ({ code: 1, stdout: '', stderr: 'docker run is not set up' })
	};
	/** @type {string[][]} */
	const calls = [];
	/** Each call's options, in the same order as `calls`. */
	/** @type {import('../container.js').RunOptions[]} */
	const call_options = [];
	const ok = (stdout = '') => ({ code: 0, stdout, stderr: '' });
	/** @param {string} stderr */
	const fail = (stderr, code = 1) => ({ code, stdout: '', stderr });
	/** @param {string} file */
	const sha1_of = async (file) =>
		new X509Certificate(await readFile(file)).fingerprint.replaceAll(':', '');

	/** @type {import('../container.js').Run} */
	const run = async (command, args, options = {}) => {
		calls.push([command, ...args]);
		call_options.push(options);
		if (state.stalls.has(`${command} ${args[0]}`)) {
			await new Promise((resolve) => setTimeout(resolve, options.timeout_ms ?? 60_000));
			return {
				code: null,
				stdout: '',
				stderr: stall_message(command, args, Number(options.timeout_ms)),
				timed_out: true
			};
		}
		if (command === 'launchctl') return ok(state.desktop);
		if (command === 'netstat') {
			if (state.netstat === 'fails')
				return fail('netstat: sysctl: net.inet.tcp.pcblist_n: Operation not permitted');
			const named = state.netstat === 'named';
			const lines = [...state.listeners].flatMap(([port, listeners]) =>
				listeners.map((listener) =>
					named
						? `${listener.proto ?? 'tcp4'}       0      0  ${listener.address}.${port}        *.*                    LISTEN                 0            0  131072  131072  ${listener.process}:${listener.pid}    00100 00000006 00000000000c38ca 00000000 00000800      1      0 000000`
						: `${listener.proto ?? 'tcp4'}       0      0  ${listener.address}.${port}        *.*                    LISTEN      131072 131072    ${listener.pid}      0 0x0000 0x0000 00000000 00000000`
				)
			);
			const header = named
				? 'Proto Recv-Q Send-Q  Local Address          Foreign Address        (state)          rxbytes      txbytes  rhiwat  shiwat          process:pid    state  options           gencnt    flags   flags1 usecnt rtncnt fltrs'
				: 'Proto Recv-Q Send-Q  Local Address          Foreign Address        (state)     rhiwat shiwat    pid   epid  state    options           gencnt    flags   flags1 usscnt rtncnt fltrs';
			return ok(['Active Internet connections (including servers)', header, ...lines].join('\n'));
		}
		if (command === 'ps') {
			const name = state.processes.get(Number(args[args.length - 1]));
			return name ? ok(name) : fail('');
		}
		if (command === 'osascript') {
			if (state.hosts_answer === 'cancel')
				return fail('0:154: execution error: User canceled. (-128)');
			if (state.hosts_answer === 'timeout')
				return { code: null, stdout: '', stderr: '', timed_out: true };
			await state.while_dialog_open();
			// As root would: the real script, with the arguments the AppleScript passes it.
			const [script, path, block, flush, sha256] = args.slice(-6);
			return real_run('/bin/sh', ['-c', script, 'syntax-test-hosts', path, block, flush, sha256]);
		}
		if (command === 'security') {
			const [subcommand] = args;
			const { certificates, trusted } = state.keychain;
			if (subcommand === 'verify-cert') {
				const files = args.filter((_, i) => args[i - 1] === '-c');
				return trusted.has(await sha1_of(files[files.length - 1]))
					? ok('...certificate verification successful.')
					: fail('Cert Verify Result: CSSMERR_TP_NOT_TRUSTED');
			}
			if (subcommand === 'find-certificate') {
				return certificates.size === 0
					? fail(
							'security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain.',
							44
						)
					: ok([...certificates].map((sha1) => `SHA-1 hash: ${sha1}`).join('\n'));
			}
			if (subcommand === 'add-trusted-cert') {
				const sha1 = await sha1_of(args[args.length - 1]);
				// macOS adds the certificate before asking for approval.
				certificates.add(sha1);
				if (state.trust_answer === 'cancel') {
					return fail(
						'SecTrustSettingsSetTrustSettings: The authorization was canceled by the user.'
					);
				}
				trusted.add(sha1);
				return ok();
			}
			if (subcommand === 'delete-certificate') {
				certificates.delete(args[args.indexOf('-Z') + 1]);
				return ok();
			}
		}
		if (command === 'docker') {
			if (!state.docker_installed) return { code: null, stdout: '', stderr: 'spawn docker ENOENT' };
			if (args[0] === 'info') {
				return state.docker_running
					? ok('29.5.3')
					: fail('Cannot connect to the Docker daemon at unix:///var/run/docker.sock.');
			}
			if (args[0] === 'context') return ok('unix:///Users/test/.docker/run/docker.sock');
			if (args[0] === 'image') return ok();
			if (args[0] === 'container' && args[1] === 'inspect') {
				const container = state.container;
				if (!container) return fail('Error: No such container: syntax-caddy');
				return ok(
					JSON.stringify({
						State: { Running: container.running },
						Config: { Image: container.image },
						HostConfig: {
							PortBindings: {
								'2019/tcp': [{ HostIp: '127.0.0.1', HostPort: String(container.admin_port) }]
							}
						}
					})
				);
			}
			if (args[0] === 'run') return state.docker_run(args);
		}
		if (command === 'open') return fail('Unable to find application');
		return { code: null, stdout: '', stderr: `spawn ${command} ENOENT` };
	};
	return { run, calls, call_options, state };
}

/** Resolves names the way macOS would with this hosts file and no DNS server. */
/** @param {string} hosts_path */
function hosts_lookup(hosts_path) {
	/** @param {string} hostname */
	return async (hostname) => {
		const text = await readFile(hosts_path, 'utf8');
		const addresses = text
			.split('\n')
			.map((line) => line.replace(/#.*/, '').trim().split(/\s+/))
			.filter(([, ...names]) => names.includes(hostname))
			.map(([address]) => address);
		if (addresses.length === 0) throw new Error(`getaddrinfo ENOTFOUND ${hostname}`);
		return addresses;
	};
}

/**
 * A Mac for setup to run on: a temporary hosts file, Caddy (unless `caddy: false`), and the
 * command stand-ins.
 * @param {{ hosts?: string, caddy?: false | Parameters<typeof start_fake_caddy>[0] }} [options]
 */
export async function create_mac({ hosts = SYSTEM_HOSTS, caddy: caddy_options = {} } = {}) {
	const directory = await mkdtemp(join(tmpdir(), 'syntax-auth-local-test-'));
	const hosts_path = join(directory, 'hosts');
	await writeFile(hosts_path, hosts);
	const { run, calls, call_options, state } = create_run();
	const admin_port = caddy_options === false ? await free_port() : undefined;
	/** @type {Awaited<ReturnType<typeof start_fake_caddy>> | null} */
	let caddy = caddy_options === false ? null : await start_fake_caddy(caddy_options);
	const config_source = {
		get config() {
			return caddy?.config;
		}
	};
	const https = await start_fake_https(config_source);
	/** @type {string[]} */
	const logs = [];
	/** @type {import('node:http').Server | null} */
	let source_server = null;
	const [setup_lock_port, container_lock_port, http_port] = await Promise.all([
		free_port(),
		free_port(),
		free_port()
	]);

	/** How this Mac opens the Docker app: quickly, and keeping its outcome in the temporary folder. */
	const docker_start = {
		platform: /** @type {NodeJS.Platform} */ ('darwin'),
		result_path: join(directory, 'docker-start.json'),
		ready_timeout_ms: 1_000,
		poll_ms: 10
	};

	if (caddy) {
		state.listeners.set(caddy.admin_port, [{ address: '127.0.0.1', process: 'caddy', pid: 610 }]);
		state.processes.set(610, '/opt/homebrew/bin/caddy');
	}

	/** @type {import('../setup.js').SetupDeps} */
	const deps = {
		run,
		platform: 'darwin',
		env: {},
		hosts_path,
		flush_dns: false,
		admin_origin: `http://127.0.0.1:${caddy?.admin_port ?? admin_port}`,
		admin_port: caddy?.admin_port ?? /** @type {number} */ (admin_port),
		https_port: https.port,
		http_port,
		keychain: '/Users/test/Library/Keychains/login.keychain-db',
		lookup: hosts_lookup(hosts_path),
		setup_lock: (task) => with_port_lock(setup_lock_port, task),
		container_lock: (task) => with_port_lock(container_lock_port, task),
		ensure_docker: (run_command) =>
			ensure_docker(run_command, {
				...docker_start,
				lock: (task) => with_port_lock(container_lock_port, task),
				why_not_open: () => why_not_open({ run: run_command, env: deps.env })
			}),
		log: (message) => logs.push(message),
		warn: (message) => logs.push(message),
		recheck_ms: 50,
		dialog_timeout_ms: 1_000,
		served_certificate_timeout_ms: 300,
		probe_timeout_ms: 300,
		command_timeout_ms: 1_000
	};

	// `docker run` of Syntax's Caddy: starts a Caddy on the admin port with the container's base
	// config, and the Docker gateway as every client's address.
	state.docker_run = async (args) => {
		const base = args.find((arg) => arg.startsWith('SYNTAX_CADDY_BASE='));
		caddy = await start_fake_caddy({
			config: JSON.parse(String(base).slice('SYNTAX_CADDY_BASE='.length)),
			port: deps.admin_port
		});
		state.container = {
			running: true,
			image: args[args.indexOf('/bin/sh') + 1],
			admin_port: deps.admin_port
		};
		state.listeners.set(deps.admin_port, [
			{ address: '127.0.0.1', process: 'com.docker.backend', pid: 812 }
		]);
		source_server = create_http_server((_, response) => response.end(DOCKER_GATEWAY));
		await listen_on(source_server, http_port);
		https.client = DOCKER_GATEWAY;
		return { code: 0, stdout: 'container-id', stderr: '' };
	};

	return {
		deps,
		docker_start,
		run,
		calls,
		call_options,
		state,
		hosts_path,
		logs,
		https,
		get caddy() {
			return caddy;
		},
		/** The commands that ran, as strings like "security add-trusted-cert". */
		commands: () => calls.map((call) => `${call[0]} ${call[1]}`),
		read_hosts: () => readFile(hosts_path, 'utf8'),
		async close() {
			await caddy?.close();
			await https.close();
			await new Promise((resolve) =>
				source_server ? source_server.close(resolve) : resolve(undefined)
			);
			await rm(directory, { recursive: true, force: true });
		}
	};
}
