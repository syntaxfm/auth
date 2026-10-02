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
