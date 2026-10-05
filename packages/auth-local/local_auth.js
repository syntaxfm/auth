// The development proxy's calls to the shared local Syntax Auth on this computer's loopback port:
// one request each, never retried, never redirected, with a limit on every wait and on the answer.
import { request } from 'node:http';

import { SYNTAX_AUTH_LOCAL_PORT } from './container.js';

/**
 * - `connect_ms`: local Syntax Auth accepts a loopback connection at once when it runs.
 * - `answer_ms`: the whole answer, which takes milliseconds; a first sign-up hashes a password.
 * - `answer_bytes`: its JSON answers are well under 4 KB.
 * @typedef {{ connect_ms: number, answer_ms: number, answer_bytes: number }} LocalAuthLimits
 */
/** @type {LocalAuthLimits} */
export const LOCAL_AUTH_LIMITS = { connect_ms: 5_000, answer_ms: 15_000, answer_bytes: 65_536 };

/**
 * @typedef {{ status: number, set_cookies: string[], body: string }} LocalAuthAnswer
 * @typedef {{ problem: string }} LocalAuthFailure
 * @typedef {{ method: 'GET' | 'POST', path: '/api/auth/get-session' | '/api/auth/sign-in/email' | '/api/auth/sign-up/email' | '/api/auth/sign-out', headers: Record<string, string>, body?: string, signal?: AbortSignal }} LocalAuthCall
 *   `signal` cancels the call: one already aborted never connects, and aborting one in flight
 *   closes its connection at once.
 * @typedef {(call: LocalAuthCall) => Promise<LocalAuthAnswer | LocalAuthFailure>} CallLocalAuth
 */

/** @param {number} ms */
function describe_ms(ms) {
	return ms >= 1_000 ? `${Math.round(ms / 1_000)} seconds` : `${ms} ms`;
}

/** @param {Error & { code?: string }} error @param {number} port */
function describe_error(error, port) {
	if (error.code === 'ECONNREFUSED')
		return `isn't running at http://localhost:${port} (connection refused)`;
	if (
		error.code === 'ECONNRESET' ||
		error.message === 'socket hang up' ||
		error.message === 'aborted'
	) {
		return 'closed the connection before it finished answering';
	}
	if (error.code?.startsWith('HPE_')) return 'sent an answer that is not valid HTTP';
	return `couldn't be reached (${error.code ?? error.message})`;
}

/**
 * Makes `call` against local Syntax Auth on 127.0.0.1:`port`, as Host `localhost:<port>`, the
 * origin it serves. Never throws: a refused, closed, stalled, oversized, malformed, or redirecting
 * answer becomes a `problem` that names it, and nothing is retried. A canceled call (see
 * LocalAuthCall's `signal`) becomes a `problem` too.
 * @param {{ port?: number, limits?: LocalAuthLimits }} [options]
 * @returns {CallLocalAuth}
 */
export function create_local_auth_caller({
	port = SYNTAX_AUTH_LOCAL_PORT,
	limits = LOCAL_AUTH_LIMITS
} = {}) {
	return ({ method, path, headers, body, signal }) =>
		new Promise((resolve) => {
			const canceled = { problem: `The call to local Syntax Auth's ${path} was canceled.` };
			if (signal?.aborted) return resolve(canceled);
			/** @type {NodeJS.Timeout | undefined} */
			let connect_timer;
			/** @type {NodeJS.Timeout | undefined} */
			let answer_timer;
			let settled = false;
			/** @param {LocalAuthAnswer | LocalAuthFailure} result */
			const finish = (result) => {
				if (settled) return;
				settled = true;
				clearTimeout(connect_timer);
				clearTimeout(answer_timer);
				signal?.removeEventListener('abort', on_abort);
				outgoing.destroy();
				resolve(result);
			};
			const on_abort = () => finish(canceled);
			/** @param {string} problem */
			const fail = (problem) => finish({ problem: `Local Syntax Auth ${problem}.` });

			const outgoing = request(
				{
					host: '127.0.0.1',
					port,
					method,
					path,
					agent: false,
					headers: {
						...headers,
						host: `localhost:${port}`,
						'cache-control': 'no-store',
						connection: 'close',
						...(body === undefined ? {} : { 'content-length': String(Buffer.byteLength(body)) })
					}
				},
				(response) => {
					const status = response.statusCode ?? 0;
					if (status >= 300 && status < 400) {
						return fail(
							`answered ${path} with a redirect (HTTP ${status}), which this proxy never follows`
						);
					}
					/** @type {Buffer[]} */
					const chunks = [];
					let size = 0;
					response.on('data', (/** @type {Buffer} */ chunk) => {
						size += chunk.length;
						if (size > limits.answer_bytes) {
							fail(`answered ${path} with more than ${limits.answer_bytes} bytes`);
						} else {
							chunks.push(chunk);
						}
					});
					response.on('error', (error) => fail(describe_error(error, port)));
					response.on('end', () =>
						finish({
							status,
							set_cookies: response.headers['set-cookie'] ?? [],
							body: Buffer.concat(chunks).toString('utf8')
						})
					);
				}
			);
			answer_timer = setTimeout(
				() => fail(`didn't answer ${path} within ${describe_ms(limits.answer_ms)}`),
				limits.answer_ms
			);
			outgoing.on('socket', (socket) => {
				connect_timer = setTimeout(
					() => fail(`didn't accept a connection within ${describe_ms(limits.connect_ms)}`),
					limits.connect_ms
				);
				socket.once('connect', () => clearTimeout(connect_timer));
			});
			outgoing.on('error', (error) => fail(describe_error(error, port)));
			outgoing.on('close', () => fail('closed the connection before it finished answering'));
			signal?.addEventListener('abort', on_abort, { once: true });
			outgoing.end(body);
		});
}
