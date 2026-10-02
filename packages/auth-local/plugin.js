// The Vite plugin. On a dev server start it keeps local Syntax Auth running and, given a site name,
// sets up that site's https://*.syntax.test name without delaying the server. Page loads on
// localhost then go to the https name once it works, or get a page naming the failed step.
import { randomUUID } from 'node:crypto';

import {
	SITE_HOSTNAMES,
	SITE_LABELS,
	SYNTAX_TEST_ALLOWED_HOST,
	get_hostname,
	has_space_or_control,
	is_loopback_hostname,
	is_route_path,
	is_site_name,
	site_url
} from './names.js';
import { render_problem_page } from './problem_page.js';
import {
	STEPS,
	describe_result,
	has_desktop,
	run_setup,
	start_recheck,
	with_command_timeouts
} from './setup.js';

export const PROBE_PATH = '/__syntax_auth_local/probe';
export const USE_LOCALHOST_PATH = '/__syntax_auth_local/use-localhost';

/**
 * @typedef {import('./names.js').SiteName} SiteName
 * @typedef {{ name?: SiteName, port?: number, routes?: { path: string, port: number }[] }} SyntaxAuthOptions
 * @typedef {import('./setup.js').SetupDeps & { ensure_syntax_auth: (options?: { can_start?: boolean }) => Promise<void> }} PluginDeps
 * @typedef {import('./setup.js').SetupResult | { state: 'running', problems: [] }} SiteStatus
 * @typedef {import('node:http').IncomingMessage} Request
 * @typedef {import('node:http').ServerResponse} Response
 * @typedef {(request: Request, response: Response, next: (error?: unknown) => void) => void} Middleware
 * @typedef {{ listening: boolean, address(): unknown, once(event: 'listening' | 'close', listener: () => void): unknown }} HttpServer
 * @typedef {{ middlewares: { use(middleware: Middleware): unknown }, httpServer: HttpServer | null }} DevServer
 */

/** @param {unknown} port */
function is_port(port) {
	return Number.isInteger(port) && Number(port) > 0 && Number(port) < 65_536;
}

/** @param {SyntaxAuthOptions} options */
function check_options({ name, port, routes }) {
	if (name !== undefined && !is_site_name(name)) {
		throw new Error(
			`syntax_auth(): name must be 'auth', 'lab', or 'website', not ${JSON.stringify(name)}.`
		);
	}
	if (port !== undefined && !is_port(port)) {
		throw new Error(`syntax_auth(): port must be a port number, not ${JSON.stringify(port)}.`);
	}
	if (routes !== undefined && (!name || !Array.isArray(routes))) {
		throw new Error('syntax_auth(): routes needs a name and must be an array of { path, port }.');
	}
	for (const route of routes ?? []) {
		if (!is_route_path(route?.path) || !is_port(route.port)) {
			throw new Error(
				`syntax_auth(): each route needs a path starting with "/" (without spaces, quotes, or backslashes) and a port number, not ${JSON.stringify(route)}.`
			);
		}
	}
}

/**
 * A browser loading a page, not a script's request. Browsers send Sec-Fetch-Mode; without it, an
 * HTML Accept header marks a page load.
 * @param {Request} request
 */
export function is_page_load(request) {
	if (request.method !== 'GET' && request.method !== 'HEAD') return false;
	const mode = request.headers['sec-fetch-mode'];
	if (mode) return mode === 'navigate';
	return (request.headers.accept ?? '').includes('text/html');
}

/** @param {Request} request @param {string} name */
function has_cookie(request, name) {
	return (request.headers.cookie ?? '')
		.split(';')
		.some((pair) => pair.split('=', 1)[0].trim() === name);
}

/**
 * Where the "use localhost" link may send the browser: only a path on this same server. A target
 * with a control character or a backslash (which browsers drop or read as "/", turning "/\t/x" or
 * "/\\x" into "//x", another origin) is refused; the rest is resolved against this request's own
 * origin and kept only when the origin stays the same. Anything else goes to "/".
 * @param {string | null} target
 * @param {string | undefined} host the request's Host header
 */
export function safe_destination(target, host) {
	if (!target || !target.startsWith('/') || target.includes('\\') || has_space_or_control(target)) {
		return '/';
	}
	try {
		const origin = new URL(`http://${host}`).origin;
		const url = new URL(target, origin);
		return url.origin === origin ? `${url.pathname}${url.search}${url.hash}` : '/';
	} catch {
		return '/';
	}
}

/**
 * @param {SiteName} name
 * @param {string} nonce
 * @param {() => SiteStatus} get_status
 * @returns {Middleware}
 */
export function create_middleware(name, nonce, get_status) {
	const hostname = SITE_HOSTNAMES[name];
	const cookie = `syntax_test_use_localhost_${name}`;

	return (request, response, next) => {
		const request_hostname = get_hostname(request.headers.host);
		const path = request.url ?? '/';
		if (request_hostname === hostname) {
			if (path !== PROBE_PATH) return next();
			response.writeHead(200, { 'content-type': 'text/plain', 'cache-control': 'no-store' });
			response.end(nonce);
			return;
		}
		// Only this computer's own names: a name like lab.syntax.test may not work elsewhere.
		if (name === 'auth' || !is_loopback_hostname(request_hostname) || !is_page_load(request)) {
			return next();
		}

		const url = new URL(path, 'http://localhost');
		if (url.pathname === USE_LOCALHOST_PATH) {
			response.writeHead(302, {
				location: safe_destination(url.searchParams.get('to'), request.headers.host),
				'set-cookie': `${cookie}=1; Path=/; HttpOnly; SameSite=Lax`,
				'cache-control': 'no-store'
			});
			response.end();
			return;
		}

		const status = get_status();
		if (status.state === 'worked') {
			response.writeHead(302, {
				location: `${site_url(name)}${path}`,
				'cache-control': 'no-store'
			});
			response.end();
			return;
		}
		if (status.state !== 'failed' || has_cookie(request, cookie)) return next();

		const page = render_problem_page({
			site_label: SITE_LABELS[name],
			https_url: site_url(name),
			localhost_url: `http://${request.headers.host}`,
			use_localhost_href: `${USE_LOCALHOST_PATH}?to=${encodeURIComponent(path)}`,
			problems: status.problems
		});
		response.writeHead(503, {
			'content-type': 'text/html; charset=utf-8',
			'cache-control': 'no-store'
		});
		response.end(page);
	};
}

/** @param {HttpServer | null} http_server */
function listening_port(http_server) {
	const address = /** @type {{ port?: unknown } | string | null} */ (http_server?.address());
	return typeof address === 'object' && address && is_port(address.port)
		? Number(address.port)
		: undefined;
}

/**
 * @param {SyntaxAuthOptions} options
 * @param {PluginDeps} deps
 */
export function create_plugin(options, deps) {
	check_options(options);
	const { name, routes } = options;

	return {
		name: 'syntax-auth-local',
		/** @type {'serve'} Never in a build. */
		apply: 'serve',
		/** @param {{ server?: { allowedHosts?: string[] | true } }} config */
		config(config) {
			if (!name || deps.env.VITEST || config.server?.allowedHosts === true) return undefined;
			return { server: { allowedHosts: [SYNTAX_TEST_ALLOWED_HOST] } };
		},
		/** @param {DevServer} server */
		configureServer(server) {
			// Vitest also runs Vite in serve mode; tests must not start containers or change setup.
			if (deps.env.VITEST) return;
			// Without a name, exactly as before: keep local Syntax Auth running.
			if (!name) {
				deps
					.ensure_syntax_auth()
					.catch((error) => console.error('Syntax Auth local startup failed', error));
				return;
			}
			// Syntax Auth's own dev server takes the container's place (scripts/local_server.js).
			// A site's dev server starts Docker and the container only on a Mac with a person at its
			// screen; on Linux, Windows, over SSH, or in CI it only checks, like the rest of setup.
			if (name !== 'auth') {
				void (async () => {
					try {
						const can_start =
							deps.platform === 'darwin' && (await has_desktop(with_command_timeouts(deps)));
						await deps.ensure_syntax_auth({ can_start });
					} catch (error) {
						deps.warn(
							`Local Syntax Auth wasn't checked: ${error instanceof Error ? error.message : String(error)}. Restart dev to try again.`
						);
					}
				})();
			}

			const nonce = randomUUID();
			/** @type {SiteStatus} */
			let status = { state: 'running', problems: [] };
			let is_closed = false;
			let stop_recheck = () => {};
			server.middlewares.use(create_middleware(name, nonce, () => status));

			/** @param {import('./setup.js').SetupResult} result @param {number | undefined} port */
			const report = (result, port) => {
				status = result;
				const [first, ...rest] = describe_result({ name }, result, port);
				const print = result.state === 'failed' ? deps.warn : deps.log;
				print([first, ...rest.map((line) => `  ${line}`)].join('\n'));
			};

			const start = async () => {
				const port = options.port ?? listening_port(server.httpServer);
				if (!port) {
					report(
						{
							state: 'failed',
							problems: [
								{
									step: STEPS.setup,
									problem: "Setup couldn't tell which port this dev server listens on.",
									fix: `Pass it to the plugin, for example \`syntax_auth({ name: '${name}', port: 5173 })\`, then restart dev.`
								}
							]
						},
						port
					);
					return;
				}
				const setup_options = { name, port, routes, nonce, probe_path: PROBE_PATH };
				const result = await run_setup(setup_options, deps);
				if (is_closed) return;
				report(result, port);
				if (result.state === 'worked') {
					stop_recheck = start_recheck(setup_options, result.context, deps, (changed) =>
						report(changed, port)
					);
				}
			};

			const http_server = server.httpServer;
			if (!http_server) return void start();
			http_server.once('close', () => {
				is_closed = true;
				stop_recheck();
			});
			if (http_server.listening) void start();
			else http_server.once('listening', () => void start());
		}
	};
}
