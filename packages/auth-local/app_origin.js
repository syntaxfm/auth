// The rules every request through an app's own address must pass before the development proxy acts
// on it (gateway.js): which hosts it answers, which origins count as the app's own, where a sign-in
// may return to, and which paths may go to another local server.
import { isIP } from 'node:net';

import { SYNTAX_AUTH_LOCAL_PORT } from './container.js';

/** Every path the development proxy answers itself starts with this. */
export const MOUNT_PATH = '/__syntax_auth';
/** Lists the extra browser-facing origins of this dev server, like `https://lab.example.dev`. */
export const PUBLIC_ORIGINS_VARIABLE = 'SYNTAX_AUTH_PUBLIC_ORIGINS';
const MAX_RETURN_LENGTH = 2_048;

/**
 * Whether text has a space or a control character (C0, DEL, or C1), which browsers strip from URLs.
 * @param {string} text
 */
export function has_space_or_control(text) {
	return [...text].some((char) => {
		const code = char.codePointAt(0) ?? 0;
		return code <= 0x20 || (code >= 0x7f && code <= 0x9f);
	});
}

/**
 * The canonical form of a browser-facing origin (`http:` or `https:`, no credentials, path, query,
 * or fragment; a trailing "/" is allowed), or null.
 * @param {unknown} value
 */
export function canonical_origin(value) {
	if (typeof value !== 'string' || has_space_or_control(value) || value.includes('\\')) return null;
	try {
		const url = new URL(value);
		if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
		if (url.username || url.password || url.search || url.hash || url.pathname !== '/') return null;
		if (!/^(?:\[[0-9a-f:.]+\]|[a-z0-9._-]+)$/.test(url.hostname)) return null;
		const given = value.toLowerCase();
		if (given !== url.origin && given !== `${url.origin}/`) return null;
		return url.origin;
	} catch {
		return null;
	}
}

/**
 * The plugin's `public_origins` option and the SYNTAX_AUTH_PUBLIC_ORIGINS variable (separated by
 * commas or spaces), as canonical origins. A value that isn't an origin stops the dev server.
 * @param {unknown} option
 * @param {NodeJS.ProcessEnv} env
 * @returns {string[]}
 */
export function read_public_origins(option, env) {
	if (option !== undefined && !Array.isArray(option)) {
		throw new Error('syntax_auth(): public_origins must be an array of origins.');
	}
	const from_env = (env[PUBLIC_ORIGINS_VARIABLE] ?? '').split(/[\s,]+/).filter(Boolean);
	/** @type {string[]} */
	const origins = [];
	for (const [value, source] of [
		...(option ?? []).map((value) => [value, 'syntax_auth(): public_origins']),
		...from_env.map((value) => [value, PUBLIC_ORIGINS_VARIABLE])
	]) {
		const origin = canonical_origin(value);
		if (!origin) {
			throw new Error(
				`${source} needs origins like https://lab.example.dev or http://box.example.ts.net:5173 (http or https, no path or credentials), not ${JSON.stringify(value)}.`
			);
		}
		if (!origins.includes(origin)) origins.push(origin);
	}
	return origins;
}

/**
 * The parts of a Host header, or null when it is anything but a host and an optional port.
 * @param {unknown} host_header
 * @returns {{ host: string, hostname: string } | null}
 */
export function parse_host(host_header) {
	if (typeof host_header !== 'string' || host_header.length === 0 || host_header.length > 255) {
		return null;
	}
	if (!/^(?:\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9._-]+)(?::\d{1,5})?$/.test(host_header)) return null;
	try {
		const url = new URL(`http://${host_header}`);
		return { host: url.host, hostname: url.hostname };
	} catch {
		return null;
	}
}

/**
 * Vite's own host rule, applied again here so the proxy answers no other host even where Vite
 * doesn't check (an `https` dev server, or `allowedHosts: true`): IP addresses, `localhost` and
 * `*.localhost`, the entries of `server.allowedHosts` (a leading "." allows a domain and every name
 * under it), and the hosts of the public origins.
 * @param {unknown} host_header
 * @param {readonly string[]} allowed_hosts
 */
export function is_allowed_host(host_header, allowed_hosts) {
	const parsed = parse_host(host_header);
	if (!parsed) return false;
	const { hostname } = parsed;
	if (hostname.startsWith('[') || isIP(hostname) === 4) return true;
	if (hostname === 'localhost' || hostname.endsWith('.localhost')) return true;
	return allowed_hosts.some((entry) => {
		const allowed = entry.toLowerCase();
		if (allowed === hostname) return true;
		return allowed.startsWith('.') && (allowed.slice(1) === hostname || hostname.endsWith(allowed));
	});
}

/**
 * The origins a browser on this request's host may have: the one this connection proves (https on
 * a TLS connection, otherwise http), plus each configured public origin with this very host. A
 * forwarded-protocol header is never read: a TLS proxy in front names its https origin in
 * SYNTAX_AUTH_PUBLIC_ORIGINS instead.
 * @param {string} host_header an allowed Host header
 * @param {{ encrypted: boolean, public_origins: readonly string[] }} options
 */
export function accepted_origins(host_header, { encrypted, public_origins }) {
	const own = new URL(`${encrypted ? 'https' : 'http'}://${host_header}`).origin;
	const configured = public_origins.filter(
		(origin) => new URL(`${new URL(origin).protocol}//${host_header}`).origin === origin
	);
	return [...new Set([own, ...configured])];
}

/**
 * The browser's origin when a state-changing request comes from this app's own pages, or why not.
 * Browsers send Origin on every POST and WebSocket upgrade, so a missing one is refused.
 * @param {import('node:http').IncomingHttpHeaders} headers
 * @param {readonly string[]} accepted
 * @returns {{ origin: string } | { problem: string }}
 */
export function check_origin(headers, accepted) {
	const origin = headers.origin;
	if (!origin || origin === 'null') {
		return { problem: 'The request has no Origin header, so it may not come from this app.' };
	}
	if (!accepted.includes(origin)) {
		const https_hint = origin.startsWith('https://')
			? ` If a TLS proxy serves this app at ${origin}, add that origin to ${PUBLIC_ORIGINS_VARIABLE} and restart dev.`
			: '';
		return {
			problem: `The request came from ${JSON.stringify(origin)}, but this address is ${accepted.join(' or ')}.${https_hint}`
		};
	}
	const site = headers['sec-fetch-site'];
	if (site && site !== 'same-origin') {
		return { problem: `The browser marked this request ${JSON.stringify(site)}, not same-origin.` };
	}
	return { origin };
}

/**
 * Where a sign-in or sign-out may send the browser: a path on this same app, kept with its query
 * and fragment. Anything else (an absolute or protocol-relative URL, a backslash, a space or control
 * character browsers would strip, a path that normalizes to "//", or one of the proxy's own paths)
 * becomes "/".
 * @param {unknown} value
 */
export function safe_return_path(value) {
	if (typeof value !== 'string' || value.length === 0 || value.length > MAX_RETURN_LENGTH)
		return '/';
	if (!value.startsWith('/') || value.startsWith('//')) return '/';
	if (value.includes('\\') || has_space_or_control(value)) return '/';
	const base = 'http://return.invalid';
	try {
		const url = new URL(value, base);
		const path = `${url.pathname}${url.search}${url.hash}`;
		if (url.origin !== base || path.startsWith('//')) return '/';
		if (url.pathname === MOUNT_PATH || url.pathname.startsWith(`${MOUNT_PATH}/`)) return '/';
		return path;
	} catch {
		return '/';
	}
}

/**
 * @typedef {{ path: string, port: number }} RouteOption
 * @typedef {{ path: string, port: number, prefix: string | null }} Route
 *   `prefix` (ending in "/") for a `/*` route, null for an exact path.
 */

const ROUTE_PATTERN =
	/^\/(?:[A-Za-z0-9_~-][A-Za-z0-9._~-]*\/)*(?:[A-Za-z0-9_~-][A-Za-z0-9._~-]*|\*)$/;

/**
 * The plugin's `routes` option, checked: each is an exact path or a `/prefix/*`, with plain
 * segments (no "." or ".." segment, no encoded characters), and a port on this computer other than
 * local Syntax Auth's own. A wrong route stops the dev server.
 * @param {unknown} routes
 * @returns {Route[]}
 */
export function parse_routes(routes) {
	if (routes === undefined) return [];
	if (!Array.isArray(routes)) {
		throw new Error('syntax_auth(): routes must be an array of { path, port }.');
	}
	return routes.map((route) => {
		const path = route?.path;
		const port = route?.port;
		if (
			typeof path !== 'string' ||
			!ROUTE_PATTERN.test(path) ||
			path === '/*' ||
			path === MOUNT_PATH ||
			path.startsWith(`${MOUNT_PATH}/`)
		) {
			throw new Error(
				`syntax_auth(): each route needs a path like '/parties/*' or '/exact/path' (plain segments, no "." or "..", not "/*" or under ${MOUNT_PATH}), not ${JSON.stringify(route)}.`
			);
		}
		if (!Number.isInteger(port) || port <= 0 || port >= 65_536) {
			throw new Error(
				`syntax_auth(): each route needs a port number, not ${JSON.stringify(route)}.`
			);
		}
		if (port === SYNTAX_AUTH_LOCAL_PORT) {
			throw new Error(
				`syntax_auth(): a route can't send paths to local Syntax Auth's port ${SYNTAX_AUTH_LOCAL_PORT}; its sign-in and sign-out already answer at ${MOUNT_PATH}/.`
			);
		}
		return { path, port, prefix: path.endsWith('/*') ? path.slice(0, -1) : null };
	});
}

/**
 * The path and query of an origin-form request target ("/path?query"), or null for any other form,
 * such as an absolute URL that names its own destination, or "//host".
 * @param {unknown} target
 */
export function split_target(target) {
	if (typeof target !== 'string' || !target.startsWith('/') || target.startsWith('//')) return null;
	const query_start = target.indexOf('?');
	return query_start === -1
		? { path: target, query: '' }
		: { path: target.slice(0, query_start), query: target.slice(query_start) };
}

/**
 * @param {string} path the raw path of the request target
 * @param {readonly Route[]} routes
 */
export function find_route(path, routes) {
	return (
		routes.find((route) => (route.prefix ? path.startsWith(route.prefix) : path === route.path)) ??
		null
	);
}

/**
 * Whether a routed path stays inside its route on any server: no "." or ".." segment, no empty
 * segment, no backslash, no encoded dot, slash, or backslash, and no space or control character.
 * @param {string} path
 */
export function is_clean_path(path) {
	if (path.includes('\\') || path.includes('//') || has_space_or_control(path)) return false;
	if (/%(?:2e|2f|5c)/i.test(path)) return false;
	return !path.split('/').some((segment) => segment === '.' || segment === '..');
}
