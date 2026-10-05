// The Vite plugin. On every dev server start it keeps the shared local Syntax Auth running, without
// delaying the server, and mounts the development proxy (gateway.js) on the app's own address.
// It never changes anything outside the dev server: no hosts file, certificate, HTTPS proxy, or
// redirect.
import { parse_routes, read_public_origins } from './app_origin.js';
import { is_set } from './container.js';
import { create_gateway } from './gateway.js';

/**
 * @typedef {object} SyntaxAuthOptions
 * @property {{ path: string, port: number }[]} [routes] paths served by another server on this
 *   computer, through the app's own address, such as `{ path: '/parties/*', port: 1348 }`
 * @property {string[]} [public_origins] browser-facing origins beyond what the connection shows,
 *   such as a TLS proxy's `https://lab.example.dev`; usually set per developer in
 *   SYNTAX_AUTH_PUBLIC_ORIGINS instead
 * @property {string} [name] deprecated and ignored; once named the site's https://*.syntax.test name
 * @property {number} [port] deprecated and ignored; once named the port that name forwarded to
 * @typedef {object} PluginDeps
 * @property {NodeJS.ProcessEnv} env
 * @property {(options: { env: NodeJS.ProcessEnv, warn: (message: string) => void }) => Promise<void>} ensure_syntax_auth
 * @property {import('./local_auth.js').CallLocalAuth} call_local_auth
 * @property {(message: string) => void} warn
 * @typedef {import('./gateway.js').Middleware} Middleware
 * @typedef {{ on(event: 'upgrade', listener: (request: import('node:http').IncomingMessage, socket: import('node:stream').Duplex, head: Buffer) => void): unknown }} HttpServer
 * @typedef {{ middlewares: { use(middleware: Middleware): unknown }, httpServer: HttpServer | null, config?: { server?: { allowedHosts?: string[] | true } } }} DevServer
 */

const OPTION_NAMES = ['routes', 'public_origins', 'name', 'port'];

/**
 * @param {SyntaxAuthOptions} options
 * @param {PluginDeps} deps
 */
export function create_plugin(options, deps) {
	if (typeof options !== 'object' || options === null || Array.isArray(options)) {
		throw new Error('syntax_auth(): options must be an object.');
	}
	const unknown = Object.keys(options).filter((key) => !OPTION_NAMES.includes(key));
	if (unknown.length > 0) {
		throw new Error(
			`syntax_auth(): unknown option ${JSON.stringify(unknown[0])}; it takes ${OPTION_NAMES.slice(0, 2).join(' and ')}.`
		);
	}
	const routes = parse_routes(options.routes);
	const public_origins = read_public_origins(options.public_origins, deps.env);

	return {
		name: 'syntax-auth-local',
		/** @type {'serve'} Never in a build. */
		apply: 'serve',
		/**
		 * Lets Vite's own host check through the public origins' names, and nothing else.
		 * @param {{ server?: { allowedHosts?: string[] | true } }} config
		 */
		config(config) {
			if (is_set(deps.env, 'VITEST') || public_origins.length === 0) return undefined;
			if (config.server?.allowedHosts === true) return undefined;
			return { server: { allowedHosts: public_origins.map((origin) => new URL(origin).hostname) } };
		},
		/** @param {DevServer} server */
		configureServer(server) {
			// Vitest also runs Vite in serve mode; tests must not start containers or serve the proxy.
			// VITEST counts when set at all, even to "" or "false".
			if (is_set(deps.env, 'VITEST')) return;

			/** @type {string | null} */
			let startup_problem = null;
			deps
				.ensure_syntax_auth({
					env: deps.env,
					warn: (message) => {
						startup_problem = message;
						deps.warn(message);
					}
				})
				.catch((error) =>
					deps.warn(
						`Local Syntax Auth's start failed: ${error instanceof Error ? error.message : String(error)}`
					)
				);

			const gateway = create_gateway({
				routes,
				public_origins,
				allowed_hosts: () => {
					const allowed = server.config?.server?.allowedHosts;
					return Array.isArray(allowed) ? allowed : [];
				},
				call_local_auth: deps.call_local_auth,
				startup_problem: () => startup_problem,
				warn: deps.warn
			});
			server.middlewares.use(gateway.handle);
			if (routes.length === 0) return;
			if (server.httpServer) {
				server.httpServer.on('upgrade', (request, socket, head) => {
					gateway.upgrade(request, socket, head);
				});
			} else {
				deps.warn(
					'This dev server has no HTTP server of its own (middleware mode), so WebSocket upgrades on routes are not proxied.'
				);
			}
		}
	};
}
