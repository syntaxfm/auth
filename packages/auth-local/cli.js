// Reads `syntax-auth-local setup <name> [--port <port>] [--route <path>=<port>]...`, the command the
// dev server prints as the fix when setup needs a person at the Mac's screen.
import { SYNTAX_AUTH_LOCAL_PORT } from './container.js';
import { SITE_LABELS, is_route_path, is_site_name } from './names.js';

export const USAGE =
	'Usage: syntax-auth-local [setup <auth|lab|website> [--port <port>] [--route <path>=<port>]...]';

/** @param {string | undefined} value */
function parse_port(value) {
	const port = Number(value);
	return value !== undefined && /^\d+$/.test(value) && port > 0 && port < 65_536 ? port : null;
}

/**
 * @param {string[]} args the arguments after `setup`
 * @returns {{ options: import('./setup.js').SetupOptions } | { error: string }}
 */
export function parse_setup_args(args) {
	const [name, ...rest] = args;
	if (!is_site_name(name)) {
		return {
			error: `Setup needs the site's name: auth, lab, or website, not ${name === undefined ? 'nothing' : JSON.stringify(name)}.\n${USAGE}`
		};
	}
	/** @type {number | undefined} */
	let port;
	/** @type {{ path: string, port: number }[]} */
	const routes = [];
	for (let i = 0; i < rest.length; i++) {
		const [flag, inline] = rest[i].split(/=(.*)/s, 2);
		if (flag !== '--port' && flag !== '--route') {
			return { error: `Setup doesn't know ${JSON.stringify(rest[i])}.\n${USAGE}` };
		}
		const value = inline ?? rest[++i];
		if (flag === '--port') {
			const parsed = parse_port(value);
			if (parsed === null)
				return {
					error: `--port needs a port number, not ${JSON.stringify(value ?? '')}.\n${USAGE}`
				};
			port = parsed;
		} else {
			const match = (value ?? '').match(/^(.*)=(\d+)$/);
			const route_port = parse_port(match?.[2]);
			if (!match || !is_route_path(match[1]) || route_port === null) {
				return {
					error: `--route needs <path>=<port>, with a path starting with "/" (without spaces, quotes, or backslashes), like '/parties/*=1999', not ${JSON.stringify(value ?? '')}.\n${USAGE}`
				};
			}
			routes.push({ path: match[1], port: route_port });
		}
	}
	if (name === 'auth') return { options: { name, port: port ?? SYNTAX_AUTH_LOCAL_PORT, routes } };
	if (port === undefined) {
		return {
			error: `Setup for ${name} needs --port, the port ${SITE_LABELS[name]}'s dev server listens on, for example \`pnpm exec syntax-auth-local setup ${name} --port 1337\`. When setup can't finish, the dev server prints this command with its port and routes filled in.`
		};
	}
	return { options: { name, port, routes } };
}
