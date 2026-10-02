// The names local Syntax Auth answers. Apps on https://syntax.test and https://*.syntax.test send
// browsers to https://auth.syntax.test, while their servers keep calling http://localhost:37960.
// A relative import, because scripts/register_oauth_client.ts loads this module outside SvelteKit.
import { is_loopback_hostname } from './loopback';

export const SYNTAX_TEST_AUTH_HOSTNAME = 'auth.syntax.test';
export const SYNTAX_TEST_AUTH_URL = 'https://auth.syntax.test';
export const SYNTAX_TEST_COOKIE_DOMAIN = '.syntax.test';
export const SYNTAX_TEST_TRUSTED_ORIGINS = [
	SYNTAX_TEST_AUTH_URL,
	'https://syntax.test',
	'https://*.syntax.test'
];
// Better Auth's session cookie name when `useSecureCookies` is on, as it is for .syntax.test.
export const SYNTAX_TEST_SESSION_COOKIE = '__Secure-better-auth.session_token';

/**
 * `loopback`: a browser or app server on localhost, with today's host-only cookie.
 * `syntax_test`: a browser on auth.syntax.test, or an app server on localhost forwarding a
 * .syntax.test browser's cookie. Both use the shared `.syntax.test` cookie.
 */
export type LocalSite = 'loopback' | 'syntax_test';

function has_cookie(cookie_header: string | null, name: string): boolean {
	if (!cookie_header) return false;

	return cookie_header.split(';').some((pair) => pair.split('=', 1)[0].trim() === name);
}

export function get_local_site(hostname: string, cookie_header: string | null): LocalSite | null {
	if (hostname === SYNTAX_TEST_AUTH_HOSTNAME) return 'syntax_test';
	if (!is_loopback_hostname(hostname)) return null;

	// Browsers on localhost never hold this cookie, so only an app server forwarding a
	// .syntax.test browser's cookies sends it here.
	return has_cookie(cookie_header, SYNTAX_TEST_SESSION_COOKIE) ? 'syntax_test' : 'loopback';
}

// An app page on https://syntax.test or https://*.syntax.test, without credentials.
export function is_syntax_test_app_url(url: URL): boolean {
	if (url.protocol !== 'https:' || url.username || url.password) return false;

	return url.hostname === 'syntax.test' || url.hostname.endsWith('.syntax.test');
}

export function local_host_refusal(hostname: string, loopback_origin: string): string {
	return `Local Syntax Auth answers only localhost and ${SYNTAX_TEST_AUTH_HOSTNAME}, so it refused this request for "${hostname}". Open ${loopback_origin} or ${SYNTAX_TEST_AUTH_URL} instead.`;
}

// The hostname SvelteKit would see for this Host header, or the header itself when it isn't a host.
export function get_host_header_hostname(host_header: string | undefined): string {
	if (!host_header) return '';

	try {
		return new URL(`http://${host_header}`).hostname;
	} catch {
		return host_header;
	}
}

export function is_local_hostname(hostname: string): boolean {
	return hostname === SYNTAX_TEST_AUTH_HOSTNAME || is_loopback_hostname(hostname);
}

// Matches the local trustedOrigins in src/lib/server/auth.ts: their `:*` patterns need a port, and
// the https patterns match no port.
export function local_origin_refusal(origin: string): string {
	return `Local Syntax Auth refused a request from origin "${origin}": it accepts only http://localhost:<port>, http://127.0.0.1:<port>, https://syntax.test, and https://*.syntax.test. Open the app at one of those addresses.`;
}

/**
 * Locally, replaces Better Auth's bare `Invalid origin` refusal with one naming the origin and the
 * addresses it accepts, keeping the 403 and the code. Deployed responses pass through unchanged.
 */
export async function name_refused_origin(
	response: Response,
	request: Request,
	is_local_development: boolean
): Promise<Response> {
	if (!is_local_development || response.status !== 403) return response;

	const body: unknown = await response
		.clone()
		.json()
		.catch(() => null);
	if (!body || typeof body !== 'object' || !('code' in body) || body.code !== 'INVALID_ORIGIN') {
		return response;
	}

	// Better Auth checks Origin, or Referer when there's no Origin.
	const origin = request.headers.get('origin') || request.headers.get('referer') || '';
	const headers = new Headers(response.headers);
	headers.delete('content-length');

	return new Response(JSON.stringify({ ...body, message: local_origin_refusal(origin) }), {
		status: 403,
		statusText: response.statusText,
		headers
	});
}
