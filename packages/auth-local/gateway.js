// The development proxy each app's dev server mounts on its own address, so a browser on
// localhost, a LAN or Tailscale address, or a developer's own HTTPS name signs in through the app
// it is using and never needs to reach localhost:37960 itself:
//
// - GET  /__syntax_auth/sign-in?return_to=/path  the sign-in page (or straight back when signed in)
// - POST /__syntax_auth/sign-in                    signs in as the Local Developer
// - POST /__syntax_auth/sign-out                   signs out centrally
// - optional routes, like /parties/*, to another server on this computer (HTTP and WebSocket)
//
// Only these. Local Syntax Auth's other endpoints are never reachable through an app, and its
// answers' bodies (which can hold the session token) never reach the browser: only its Set-Cookie
// headers do, each unchanged. Every state-changing request must come from this app's own origin.
import { request as http_request } from 'node:http';
import { connect } from 'node:net';

import {
	MOUNT_PATH,
	PUBLIC_ORIGINS_VARIABLE,
	accepted_origins,
	check_origin,
	find_route,
	is_allowed_host,
	is_clean_path,
	parse_host,
	safe_return_path,
	split_target
} from './app_origin.js';
import { LOCAL_DEVELOPER } from './local_developer.js';
import {
	PAGE_HEADERS,
	SIGN_IN_PATH,
	SIGN_OUT_PATH,
	render_problem_page,
	render_sign_in_page
} from './pages.js';

/**
 * The browser's origin, as the proxy checked it, on each sign-in and sign-out it sends to local
 * Syntax Auth. Local Syntax Auth reads it only in local mode, only on its loopback names, and only
 * when it equals the request's Origin; it then trusts that origin for the request and picks
 * `__Secure-` cookies for an https one. The proxy drops any copy a client sent.
 */
export const DEV_ORIGIN_HEADER = 'x-syntax-auth-dev-origin';

/**
 * - `form_bytes`, `form_ms`: the sign-in and sign-out forms carry one short field.
 * - `route_connect_ms`, `route_answer_ms`: a routed server on this computer accepts at once and
 *   starts answering (or upgrading) within seconds.
 * - `route_body_bytes`: a routed HTTP request's body.
 * - `route_idle_ms`: a routed HTTP exchange with no traffic either way. WebSockets have none once
 *   upgraded: they may stay quiet.
 * - `route_answer_ms` also bounds a routed upgrade's whole answer head (a complete `101`), which
 *   may be at most `upgrade_head_bytes`.
 * - `refusal_close_ms`: how long a refused upgrade's socket may stay open for its answer to drain,
 *   when the client doesn't close its own side first.
 * @typedef {{ form_bytes: number, form_ms: number, route_connect_ms: number, route_answer_ms: number, route_body_bytes: number, route_idle_ms: number, upgrade_head_bytes: number, refusal_close_ms: number }} GatewayLimits
 */
/** @type {GatewayLimits} */
export const GATEWAY_LIMITS = {
	form_bytes: 4_096,
	form_ms: 10_000,
	route_connect_ms: 5_000,
	route_answer_ms: 30_000,
	route_body_bytes: 1_048_576,
	route_idle_ms: 120_000,
	upgrade_head_bytes: 16_384,
	refusal_close_ms: 2_000
};

/**
 * @typedef {import('node:http').IncomingMessage} Request
 * @typedef {import('node:http').ServerResponse} Response
 * @typedef {import('node:stream').Duplex} Socket
 * @typedef {(request: Request, response: Response, next: (error?: unknown) => void) => void} Middleware
 * @typedef {object} GatewayOptions
 * @property {readonly import('./app_origin.js').Route[]} routes
 * @property {readonly string[]} public_origins
 * @property {() => readonly string[]} allowed_hosts Vite's `server.allowedHosts` (empty for `true`)
 * @property {import('./local_auth.js').CallLocalAuth} call_local_auth
 * @property {() => string | null} startup_problem what local Syntax Auth's start reported, if anything
 * @property {(message: string) => void} warn
 * @property {GatewayLimits} [limits]
 */

// Headers that belong to one connection, never forwarded (RFC 9110, section 7.6.1).
const HOP_BY_HOP = new Set([
	'connection',
	'keep-alive',
	'proxy-authenticate',
	'proxy-authorization',
	'proxy-connection',
	'te',
	'trailer',
	'transfer-encoding',
	'upgrade'
]);
const JSON_HEADERS = { accept: 'application/json', 'content-type': 'application/json' };

/** @param {number} ms */
function describe_ms(ms) {
	return ms >= 1_000 ? `${Math.round(ms / 1_000)} seconds` : `${ms} ms`;
}

/** @param {Socket} socket */
function is_encrypted(socket) {
	return /** @type {{ encrypted?: unknown }} */ (socket).encrypted === true;
}

/**
 * The request's host: its Host header, or HTTP/2's `:authority` (Vite's own https server).
 * @param {Request} request
 */
function request_host(request) {
	const host = request.headers.host ?? request.headers[':authority'];
	return typeof host === 'string' ? host : undefined;
}

/** @param {Response} response */
function is_http1(response) {
	return response.req?.httpVersionMajor === 1;
}

/**
 * The headers to forward to a routed server: all but the connection's own (and HTTP/2's pseudo
 * headers) and the proxy's metadata, with the request's checked host.
 * @param {Request} request
 */
function forward_headers(request) {
	const headers = request.headers;
	const named = String(headers.connection ?? '')
		.split(',')
		.map((token) => token.trim().toLowerCase());
	/** @type {import('node:http').OutgoingHttpHeaders} */
	const forwarded = {};
	for (const [name, value] of Object.entries(headers)) {
		if (value === undefined || HOP_BY_HOP.has(name) || named.includes(name)) continue;
		if (name === DEV_ORIGIN_HEADER || name.startsWith(':')) continue;
		forwarded[name] = value;
	}
	forwarded.host = request_host(request);
	return forwarded;
}

/**
 * @param {Response} response
 * @param {number} status
 * @param {string} text
 */
function send_text(response, status, text) {
	if (response.headersSent) return void response.destroy();
	response.writeHead(status, {
		'content-type': 'text/plain; charset=utf-8',
		'cache-control': 'no-store',
		'x-content-type-options': 'nosniff',
		...(is_http1(response) ? { connection: 'close' } : {})
	});
	response.end(text);
}

/**
 * @param {Request} request
 * @param {Response} response
 * @param {number} status
 * @param {string} html
 * @param {string[]} [set_cookies]
 */
function send_page(request, response, status, html, set_cookies = []) {
	response.writeHead(status, {
		...PAGE_HEADERS,
		...(set_cookies.length > 0 ? { 'set-cookie': set_cookies } : {})
	});
	response.end(request.method === 'HEAD' ? undefined : html);
}

/**
 * A 303 to a path on this same app, with each of local Syntax Auth's cookies as its own header.
 * @param {Response} response
 * @param {string} return_path
 * @param {string[]} set_cookies
 */
function send_redirect(response, return_path, set_cookies) {
	response.writeHead(303, {
		location: return_path,
		'cache-control': 'no-store',
		...(set_cookies.length > 0 ? { 'set-cookie': set_cookies } : {})
	});
	response.end();
}

/**
 * The form's fields, or why it can't be read. Only an HTML form post (or no body) is accepted, of
 * at most `limits.form_bytes`, arriving within `limits.form_ms`.
 * @param {Request} request
 * @param {GatewayLimits} limits
 * @returns {Promise<{ form: URLSearchParams } | { status: number, problem: string }>}
 */
function read_form(request, limits) {
	const type = (request.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
	const length = request.headers['content-length'];
	const has_body =
		request.headers['transfer-encoding'] !== undefined || (length !== undefined && length !== '0');
	if (has_body && type !== 'application/x-www-form-urlencoded') {
		return Promise.resolve({
			status: 415,
			problem: 'This takes an HTML form post (application/x-www-form-urlencoded) only.'
		});
	}
	if (length !== undefined && !(Number(length) <= limits.form_bytes)) {
		return Promise.resolve({
			status: 413,
			problem: `The form is larger than ${limits.form_bytes} bytes.`
		});
	}
	return new Promise((resolve) => {
		/** @type {Buffer[]} */
		const chunks = [];
		let size = 0;
		let settled = false;
		/** @param {{ form: URLSearchParams } | { status: number, problem: string }} result */
		const finish = (result) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			request.removeListener('data', on_data);
			if (!('form' in result)) request.resume();
			resolve(result);
		};
		const timer = setTimeout(
			() =>
				finish({
					status: 408,
					problem: `The form didn't arrive within ${describe_ms(limits.form_ms)}.`
				}),
			limits.form_ms
		);
		/** @param {Buffer} chunk */
		const on_data = (chunk) => {
			size += chunk.length;
			if (size > limits.form_bytes) {
				finish({ status: 413, problem: `The form is larger than ${limits.form_bytes} bytes.` });
			} else {
				chunks.push(chunk);
			}
		};
		request.on('data', on_data);
		request.once('end', () =>
			finish({ form: new URLSearchParams(Buffer.concat(chunks).toString('utf8')) })
		);
		request.once('aborted', () =>
			finish({ status: 400, problem: 'The browser stopped sending the form.' })
		);
		request.once('error', () =>
			finish({ status: 400, problem: 'The browser stopped sending the form.' })
		);
	});
}

/**
 * Whether local Syntax Auth's get-session answer holds a session, or what is wrong with it. The
 * answer's body (which holds the session token) is only read here, never passed on.
 * @param {import('./local_auth.js').LocalAuthAnswer} answer
 * @returns {{ signed_in: boolean } | { problem: string }}
 */
function read_session(answer) {
	if (answer.status !== 200) {
		return { problem: `Local Syntax Auth answered the session check with HTTP ${answer.status}.` };
	}
	/** @type {unknown} */
	let session;
	try {
		session = JSON.parse(answer.body);
	} catch {
		return {
			problem: 'Local Syntax Auth answered the session check with something other than JSON.'
		};
	}
	if (session === null) return { signed_in: false };
	// Null or mismatched records must not bounce forever between the app and this page.
	if (is_record(session) && is_record(session.user) && is_record(session.session)) {
		const user = session.user;
		const identity = session.session;
		if (
			typeof user.id === 'string' &&
			user.id.length > 0 &&
			typeof identity.id === 'string' &&
			identity.id.length > 0 &&
			identity.userId === user.id &&
			typeof identity.expiresAt === 'string' &&
			Number.isFinite(Date.parse(identity.expiresAt))
		) {
			return { signed_in: true };
		}
	}
	return { problem: "Local Syntax Auth's session answer has an unknown shape." };
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function is_record(value) {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Why an upgrade answer's head (up to, not including, its blank line) isn't a valid switch to the
 * requested protocol, or null when it is: an HTTP/1.1 `101` with an `Upgrade` header and
 * `Connection: upgrade` (RFC 9110, section 7.8), and only well-formed header lines.
 * @param {string} head
 * @returns {string | null}
 */
function check_upgrade_head(head) {
	const [status_line, ...lines] = head.split('\r\n');
	const status = /^HTTP\/1\.1 (\d{3})(?: [^\r\n]*)?$/.exec(status_line);
	if (!status) return 'sent an answer that is not a valid upgrade (not HTTP/1.1)';
	if (status[1] !== '101') return `answered the upgrade with HTTP ${status[1]}, not 101`;
	/** @type {Map<string, string>} */
	const headers = new Map();
	for (const line of lines) {
		const header = /^([!#$%&'*+.^_`|~0-9A-Za-z-]+):[ \t]*(.*?)[ \t]*$/.exec(line);
		if (!header) return 'sent an answer that is not a valid upgrade (a malformed header)';
		const name = header[1].toLowerCase();
		headers.set(name, headers.has(name) ? `${headers.get(name)}, ${header[2]}` : header[2]);
	}
	const connection = (headers.get('connection') ?? '')
		.split(',')
		.map((token) => token.trim().toLowerCase());
	if (!headers.get('upgrade') || !connection.includes('upgrade')) {
		return 'sent an answer that is not a valid upgrade (101 without Upgrade and Connection: upgrade)';
	}
	return null;
}

/**
 * The path an absolute or "//" request target names, or "" when it isn't a URL at all.
 * @param {string | undefined} target
 */
function target_pathname(target) {
	try {
		return new URL(target ?? '', 'http://target.invalid').pathname;
	} catch {
		return '';
	}
}

/**
 * @param {GatewayOptions} options
 * @returns {{ handle: Middleware, upgrade: (request: Request, socket: Socket, head: Buffer) => boolean }}
 */
export function create_gateway(options) {
	const limits = options.limits ?? GATEWAY_LIMITS;
	const public_hosts = options.public_origins.map((origin) => new URL(origin).hostname);
	const call = options.call_local_auth;

	/** @param {Request} request */
	const host_problem = (request) => {
		const host = request_host(request);
		if (is_allowed_host(host, [...options.allowed_hosts(), ...public_hosts])) return null;
		const hostname = parse_host(host)?.hostname ?? host ?? '';
		return `Blocked request. This host (${JSON.stringify(hostname)}) is not allowed. To use it, add its origin (like https://${hostname || 'name.example'}) to ${PUBLIC_ORIGINS_VARIABLE}, then restart dev.`;
	};

	/** @param {Request} request */
	const accepted_for = (request) =>
		accepted_origins(/** @type {string} */ (request_host(request)), {
			encrypted: is_encrypted(request.socket),
			public_origins: options.public_origins
		});

	/**
	 * @param {Request} request
	 * @param {Response} response
	 * @param {string} title
	 * @param {number} status
	 * @param {string} problem
	 * @param {import('./pages.js').Retry | null} retry
	 */
	const fail_page = (request, response, status, title, problem, retry) => {
		options.warn(`${title}: ${problem}`);
		const startup_problem = status === 503 ? options.startup_problem() : null;
		send_page(
			request,
			response,
			status,
			render_problem_page({ title, problem, startup_problem, retry })
		);
	};

	/**
	 * @param {Request} request
	 * @param {Response} response
	 * @param {string} query
	 * @param {AbortSignal} signal
	 */
	async function show_sign_in(request, response, query, signal) {
		const return_path = safe_return_path(new URLSearchParams(query.slice(1)).get('return_to'));
		const retry = /** @type {const} */ ({ kind: 'sign-in', return_path });
		const cookie = request.headers.cookie;
		const answer = await call({
			method: 'GET',
			path: '/api/auth/get-session',
			headers: { accept: 'application/json', ...(cookie ? { cookie } : {}) },
			signal
		});
		if (signal.aborted) return;
		if ('problem' in answer) {
			return fail_page(request, response, 503, "Can't sign in yet", answer.problem, retry);
		}
		const session = read_session(answer);
		if ('problem' in session) {
			return fail_page(request, response, 502, "Can't sign in yet", session.problem, retry);
		}
		if (session.signed_in) return send_redirect(response, return_path, answer.set_cookies);
		const host = /** @type {string} */ (request_host(request));
		send_page(
			request,
			response,
			200,
			render_sign_in_page({ host, return_path }),
			answer.set_cookies
		);
	}

	/**
	 * @param {Request} request
	 * @param {Response} response
	 * @param {'sign-in' | 'sign-out'} kind
	 * @param {AbortSignal} signal
	 * @returns {Promise<{ origin: string, return_path: string } | null>} null once refused or canceled
	 */
	async function read_post(request, response, kind, signal) {
		const title = kind === 'sign-in' ? 'Sign-in refused' : 'Sign-out refused';
		const checked = check_origin(request.headers, accepted_for(request));
		if ('problem' in checked) {
			fail_page(request, response, 403, title, checked.problem, null);
			return null;
		}
		const read = await read_form(request, limits);
		if (signal.aborted) return null;
		if ('problem' in read) {
			if (is_http1(response)) response.setHeader('connection', 'close');
			fail_page(request, response, read.status, title, read.problem, null);
			return null;
		}
		return { origin: checked.origin, return_path: safe_return_path(read.form.get('return_to')) };
	}

	/**
	 * Signs in, passing on the browser's cookies so local Syntax Auth can expire an older session
	 * cookie that would be read before the new one (src/lib/server/local_session_cookies.ts).
	 * @param {Request} request
	 * @param {Response} response
	 * @param {AbortSignal} signal
	 */
	async function sign_in(request, response, signal) {
		const post = await read_post(request, response, 'sign-in', signal);
		if (!post) return;
		const retry = /** @type {const} */ ({ kind: 'sign-in', return_path: post.return_path });
		const cookie = request.headers.cookie;
		const headers = {
			...JSON_HEADERS,
			origin: post.origin,
			[DEV_ORIGIN_HEADER]: post.origin,
			...(cookie ? { cookie } : {})
		};
		const { email, password, name } = LOCAL_DEVELOPER;
		let answer = await call({
			method: 'POST',
			path: '/api/auth/sign-in/email',
			headers,
			body: JSON.stringify({ email, password }),
			signal
		});
		// A browser that left gets nothing more: above all, no account creation.
		if (signal.aborted) return;
		// The first sign-in on a fresh local database creates the account, as Syntax Auth's own
		// sign-in page does. Nothing is ever repeated.
		if (!('problem' in answer) && answer.status === 401) {
			answer = await call({
				method: 'POST',
				path: '/api/auth/sign-up/email',
				headers,
				body: JSON.stringify({ email, password, name }),
				signal
			});
			if (signal.aborted) return;
		}
		if ('problem' in answer) {
			return fail_page(request, response, 503, "Couldn't sign in", answer.problem, retry);
		}
		if (answer.status !== 200) {
			// Upstream messages may contain credentials or stacks; status is enough to identify the failure.
			const problem = `Local Syntax Auth refused the sign-in (HTTP ${answer.status}).`;
			return fail_page(request, response, 502, "Couldn't sign in", problem, retry);
		}
		if (answer.set_cookies.length === 0) {
			const problem = 'Local Syntax Auth signed in without setting a session cookie.';
			return fail_page(request, response, 502, "Couldn't sign in", problem, retry);
		}
		send_redirect(response, post.return_path, answer.set_cookies);
	}

	/**
	 * Signs out every local session whose cookie the browser sent, whatever this origin's scheme.
	 * @param {Request} request
	 * @param {Response} response
	 * @param {AbortSignal} signal
	 */
	async function sign_out(request, response, signal) {
		const post = await read_post(request, response, 'sign-out', signal);
		if (!post) return;
		const retry = /** @type {const} */ ({ kind: 'sign-out', return_path: post.return_path });
		const cookie = request.headers.cookie;
		const answer = await call({
			method: 'POST',
			path: '/api/auth/sign-out',
			headers: {
				...JSON_HEADERS,
				origin: post.origin,
				[DEV_ORIGIN_HEADER]: post.origin,
				...(cookie ? { cookie } : {})
			},
			body: '{}',
			signal
		});
		if (signal.aborted) return;
		if ('problem' in answer) {
			return fail_page(request, response, 503, "Couldn't sign out", answer.problem, retry);
		}
		if (answer.status !== 200) {
			const problem = `Local Syntax Auth refused the sign-out (HTTP ${answer.status}).`;
			return fail_page(request, response, 502, "Couldn't sign out", problem, retry);
		}
		send_redirect(response, post.return_path, answer.set_cookies);
	}

	/**
	 * @param {Request} request
	 * @param {Response} response
	 * @param {string} path
	 * @param {string} query
	 */
	function handle_mount(request, response, path, query) {
		const method = request.method ?? 'GET';
		const is_call =
			(path === SIGN_IN_PATH && ['GET', 'HEAD', 'POST'].includes(method)) ||
			(path === SIGN_OUT_PATH && method === 'POST');
		if (is_call) {
			// The browser leaving (its connection or stream closing before the answer is sent)
			// cancels the call to local Syntax Auth in flight, and every step after it.
			const controller = new AbortController();
			const cancel = () => {
				if (!response.writableFinished) controller.abort();
			};
			response.once('close', cancel);
			request.once('aborted', cancel);
			const { signal } = controller;
			if (path === SIGN_OUT_PATH) return sign_out(request, response, signal);
			if (method === 'POST') return sign_in(request, response, signal);
			return show_sign_in(request, response, query, signal);
		}
		if (path === SIGN_IN_PATH || path === SIGN_OUT_PATH) {
			response.setHeader('allow', path === SIGN_IN_PATH ? 'GET, HEAD, POST' : 'POST');
			send_text(response, 405, `${path} doesn't answer ${method}.`);
			return;
		}
		send_text(response, 404, `${path} isn't a path of the Syntax Auth development proxy.`);
	}

	/**
	 * @param {Request} request
	 * @param {Response} response
	 * @param {import('./app_origin.js').Route} route
	 */
	function proxy_route(request, response, route) {
		const method = request.method ?? 'GET';
		if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) {
			const checked = check_origin(request.headers, accepted_for(request));
			if ('problem' in checked) return send_text(response, 403, checked.problem);
		}
		const length = request.headers['content-length'];
		if (length !== undefined && !(Number(length) <= limits.route_body_bytes)) {
			return send_text(
				response,
				413,
				`The request body is larger than ${limits.route_body_bytes} bytes.`
			);
		}

		const where = `${route.path} (127.0.0.1:${route.port})`;
		let settled = false;
		/** @type {NodeJS.Timeout | undefined} */
		let connect_timer;
		/** @param {number} status @param {string} problem */
		const fail = (status, problem) => {
			if (settled) return;
			settled = true;
			clearTimeout(connect_timer);
			clearTimeout(answer_timer);
			outgoing.destroy();
			options.warn(`${where}: ${problem}`);
			send_text(response, status, problem);
		};

		const outgoing = http_request(
			{
				host: '127.0.0.1',
				port: route.port,
				method,
				path: request.url,
				agent: false,
				headers: forward_headers(request)
			},
			(answer) => {
				if (settled) return void answer.destroy();
				settled = true;
				clearTimeout(answer_timer);
				/** @type {import('node:http').OutgoingHttpHeaders} */
				const headers = {};
				for (const [name, value] of Object.entries(answer.headers)) {
					if (value !== undefined && !HOP_BY_HOP.has(name)) headers[name] = value;
				}
				response.writeHead(answer.statusCode ?? 502, headers);
				answer.pipe(response);
				answer.once('error', () => response.destroy());
				answer.once('aborted', () => response.destroy());
			}
		);
		const answer_timer = setTimeout(
			() =>
				fail(504, `Nothing answered for ${where} within ${describe_ms(limits.route_answer_ms)}.`),
			limits.route_answer_ms
		);
		outgoing.on('socket', (socket) => {
			connect_timer = setTimeout(
				() =>
					fail(
						502,
						`${where} didn't accept a connection within ${describe_ms(limits.route_connect_ms)}.`
					),
				limits.route_connect_ms
			);
			socket.once('connect', () => clearTimeout(connect_timer));
		});
		outgoing.setTimeout(limits.route_idle_ms, () => {
			if (!settled) fail(504, `${where} went quiet for ${describe_ms(limits.route_idle_ms)}.`);
			else outgoing.destroy();
			response.destroy();
		});
		outgoing.on('error', (/** @type {Error & { code?: string }} */ error) =>
			fail(
				502,
				error.code === 'ECONNREFUSED'
					? `Nothing is running for ${where}. Start that server, then reload.`
					: `${where} failed: ${error.code ?? error.message}.`
			)
		);
		response.once('close', () => {
			if (!response.writableFinished) outgoing.destroy();
		});

		let size = 0;
		request.on('data', (/** @type {Buffer} */ chunk) => {
			size += chunk.length;
			if (size > limits.route_body_bytes) {
				request.removeAllListeners('data');
				request.resume();
				fail(413, `The request body is larger than ${limits.route_body_bytes} bytes.`);
				return;
			}
			if (!outgoing.write(chunk)) request.pause();
		});
		outgoing.on('drain', () => request.resume());
		request.once('end', () => outgoing.end());
		request.once('aborted', () => outgoing.destroy());
	}

	/** @type {Middleware} */
	const handle = (request, response, next) => {
		const target = split_target(request.url);
		if (!target) {
			// An absolute or "//" target names its own destination: never follow one to the proxy.
			const pathname = target_pathname(request.url);
			const is_ours =
				pathname === MOUNT_PATH ||
				pathname.startsWith(`${MOUNT_PATH}/`) ||
				find_route(pathname, options.routes) !== null;
			if (!is_ours) return next();
			return send_text(response, 400, 'The request target must be a path on this app.');
		}
		const is_mount = target.path === MOUNT_PATH || target.path.startsWith(`${MOUNT_PATH}/`);
		const route = is_mount ? null : find_route(target.path, options.routes);
		if (!is_mount && !route) return next();

		const blocked = host_problem(request);
		if (blocked) return send_text(response, 403, blocked);

		if (route) {
			if (!is_clean_path(target.path)) {
				return send_text(response, 400, `The path doesn't stay inside ${route.path}.`);
			}
			return proxy_route(request, response, route);
		}
		Promise.resolve(handle_mount(request, response, target.path, target.query)).catch((error) => {
			options.warn(
				`The development sign-in failed unexpectedly: ${error instanceof Error ? error.message : String(error)}`
			);
			send_text(
				response,
				500,
				'The development sign-in failed unexpectedly. See the dev server log.'
			);
		});
	};

	/**
	 * Answers an upgrade with an HTTP error and closes it, once: it ends the proxy's side, discards
	 * whatever the client still sends, and destroys the socket once the client ends its side too, or
	 * after `limits.refusal_close_ms` at most, so a refused client can't hold it open.
	 * @param {Socket} socket
	 * @param {string} route_path
	 * @param {number} status
	 * @param {string} reason
	 * @param {string} problem
	 */
	const refuse_upgrade = (socket, route_path, status, reason, problem) => {
		if (refused.has(socket) || socket.destroyed) return;
		refused.add(socket);
		options.warn(`${route_path} upgrade: ${problem}`);
		const close_timer = setTimeout(() => socket.destroy(), limits.refusal_close_ms);
		socket.once('close', () => clearTimeout(close_timer));
		socket.once('end', () => socket.destroy());
		socket.resume();
		socket.end(
			`HTTP/1.1 ${status} ${reason}\r\ncontent-type: text/plain; charset=utf-8\r\ncontent-length: ${Buffer.byteLength(problem)}\r\nconnection: close\r\n\r\n${problem}`
		);
	};
	/** @type {WeakSet<Socket>} */
	const refused = new WeakSet();

	/**
	 * Connects an upgrade to its route's server and, once that server's whole answer head is a valid
	 * `101` (within `limits.route_answer_ms` and `limits.upgrade_head_bytes`), passes bytes both ways
	 * with no further limit. Anything else is refused with a 502 or 504, and both sides are closed.
	 * @param {Request} request
	 * @param {Socket} socket
	 * @param {Buffer} head
	 * @param {import('./app_origin.js').Route} route
	 */
	const tunnel = (request, socket, head, route) => {
		const where = `${route.path} (127.0.0.1:${route.port})`;
		let answered = false;
		const upstream = connect({ host: '127.0.0.1', port: route.port });
		/** @param {number} status @param {string} reason @param {string} problem */
		const refuse = (status, reason, problem) => {
			stop();
			upstream.destroy();
			refuse_upgrade(socket, route.path, status, reason, problem);
		};
		const connect_timer = setTimeout(
			() =>
				refuse(
					502,
					'Bad Gateway',
					`${where} didn't accept a connection within ${describe_ms(limits.route_connect_ms)}.`
				),
			limits.route_connect_ms
		);
		const answer_timer = setTimeout(
			() =>
				refuse(
					504,
					'Gateway Timeout',
					`${where} didn't complete its upgrade answer within ${describe_ms(limits.route_answer_ms)}.`
				),
			limits.route_answer_ms
		);
		function stop() {
			clearTimeout(connect_timer);
			clearTimeout(answer_timer);
		}

		/** @type {Buffer} */
		let received = Buffer.alloc(0);
		/** @param {Buffer} chunk */
		const read_answer = (chunk) => {
			received = Buffer.concat([received, chunk]);
			const head_end = received.indexOf('\r\n\r\n');
			const head_length = head_end === -1 ? received.length : head_end + 4;
			if (head_length > limits.upgrade_head_bytes) {
				return refuse(
					502,
					'Bad Gateway',
					`${where} sent an upgrade answer head larger than ${limits.upgrade_head_bytes} bytes.`
				);
			}
			if (head_end === -1) return;
			upstream.removeListener('data', read_answer);
			const problem = check_upgrade_head(received.subarray(0, head_end).toString('latin1'));
			if (problem) return refuse(502, 'Bad Gateway', `${where} ${problem}.`);

			answered = true;
			stop();
			upstream.pause();
			socket.write(received);
			upstream.pipe(socket);
			socket.pipe(upstream);
			// Either side ending ends the tunnel: the dev server keeps upgraded sockets half-open.
			socket.once('end', () => socket.end());
			upstream.once('end', () => upstream.end());
		};

		upstream.once('connect', () => {
			clearTimeout(connect_timer);
			const lines = [`GET ${request.url} HTTP/1.1`];
			for (let i = 0; i < request.rawHeaders.length; i += 2) {
				if (request.rawHeaders[i].toLowerCase() === DEV_ORIGIN_HEADER) continue;
				lines.push(`${request.rawHeaders[i]}: ${request.rawHeaders[i + 1]}`);
			}
			upstream.write(`${lines.join('\r\n')}\r\n\r\n`);
			if (head.length > 0) upstream.write(head);
			upstream.on('data', read_answer);
		});
		upstream.on('error', (/** @type {Error & { code?: string }} */ error) => {
			stop();
			if (answered) return void socket.destroy();
			refuse(
				502,
				'Bad Gateway',
				error.code === 'ECONNREFUSED'
					? `Nothing is running for ${where}. Start that server, then reload.`
					: `${where} failed: ${error.code ?? error.message}.`
			);
		});
		upstream.once('close', () => {
			stop();
			if (answered) socket.destroy();
			else refuse(502, 'Bad Gateway', `${where} closed the connection without answering.`);
		});
		socket.once('close', () => {
			stop();
			upstream.destroy();
		});
	};

	/**
	 * Proxies a WebSocket upgrade on a route; returns false for any other path, which stays Vite's.
	 * @param {Request} request
	 * @param {Socket} socket
	 * @param {Buffer} head
	 */
	const upgrade = (request, socket, head) => {
		const target = split_target(request.url);
		if (!target) {
			const path = target_pathname(request.url);
			const route = find_route(path, options.routes);
			if (!route) return false;
			socket.on('error', () => socket.destroy());
			refuse_upgrade(
				socket,
				route.path,
				400,
				'Bad Request',
				'The request target must be a path on this app.'
			);
			return true;
		}
		const route = find_route(target.path, options.routes);
		if (!route) return false;
		socket.on('error', () => socket.destroy());

		const blocked = host_problem(request);
		if (blocked) {
			refuse_upgrade(socket, route.path, 403, 'Forbidden', blocked);
			return true;
		}
		if (request.method !== 'GET' || !is_clean_path(target.path)) {
			refuse_upgrade(
				socket,
				route.path,
				400,
				'Bad Request',
				`The upgrade doesn't stay inside ${route.path}.`
			);
			return true;
		}
		const checked = check_origin(request.headers, accepted_for(request));
		if ('problem' in checked) {
			refuse_upgrade(socket, route.path, 403, 'Forbidden', checked.problem);
			return true;
		}
		tunnel(request, socket, head, route);
		return true;
	};

	return { handle, upgrade };
}
