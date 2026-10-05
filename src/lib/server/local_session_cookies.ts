// Local mode only: which local sessions a sign-out ends, and which old cookie a sign-in expires.
//
// One browser can hold both of local Syntax Auth's session cookies for one host, because cookies
// ignore ports and, mostly, schemes: `better-auth.session_token`, set from an http address, is sent
// to the https address of the same name too, and `__Secure-better-auth.session_token`, set from an
// https one, is sent to http://localhost as well. Both are host-only. Better Auth reads only the
// one name it is configured for, and app servers' direct calls pick `__Secure-` when it is there
// (src/lib/server/dev_proxy.ts), as Better Auth's own getSessionCookie does. So:
//
// - The request's origin still picks the cookie a sign-in issues and its `Secure` attribute.
// - A sign-out ends the session of each session cookie the request carries, whatever its origin:
//   one Better Auth sign-out per cookie name, each clearing its own cookies in its own Set-Cookie
//   headers. A failing one stops there, with what was already cleared; nothing is repeated.
// - A sign-in that issues the plain cookie also expires the `__Secure-` session cookies the request
//   carries, which would otherwise be read before the new one. Their sessions are left alone.
//
// Get-session and everything deployed are unchanged. Response bodies, which hold the token, pass
// through untouched and are never read here.
import { getCookies } from 'better-auth/cookies';

import { get_cookie_options } from './auth';
import { SECURE_SESSION_COOKIE } from './dev_proxy';
import type { AuthEnvironment, LocalAuthEnvironment } from './env';

// Better Auth's session cookie name when `useSecureCookies` is off.
export const SESSION_COOKIE = 'better-auth.session_token';

// Better Auth's own handler, made for the environment given.
type HandleAuth = (environment: AuthEnvironment, request: Request) => Promise<Response>;

// Each cookie name in a Cookie header, as Better Auth's parser reads them.
function cookie_names(cookie_header: string | null): Set<string> {
	const names = new Set<string>();
	for (const pair of (cookie_header ?? '').split(';')) {
		const separator = pair.indexOf('=');
		if (separator > 0) names.add(pair.slice(0, separator).trim());
	}
	return names;
}

// Better Auth's own session cookies (name and attributes) for one profile.
function profile_cookies(environment: LocalAuthEnvironment, use_secure_cookies: boolean) {
	const cookies = getCookies({
		baseURL: environment.BETTER_AUTH_URL,
		advanced: get_cookie_options({ ...environment, use_secure_cookies })
	});
	return [cookies.sessionToken, cookies.sessionData, cookies.dontRememberToken];
}

// The profiles (`true` for `__Secure-`) whose session cookie the request carries, plain first.
export function carried_profiles(cookie_header: string | null): boolean[] {
	const names = cookie_names(cookie_header);
	return [false, true].filter((secure) =>
		names.has(secure ? SECURE_SESSION_COOKIE : SESSION_COOKIE)
	);
}

// A Set-Cookie header that expires a cookie, as Better Auth's expireCookie writes it.
export function expiring_set_cookie(
	name: string,
	attributes: { path?: string; httpOnly?: boolean; secure?: boolean; sameSite?: string }
): string {
	const parts = [`${name}=`, 'Max-Age=0'];
	if (attributes.path) parts.push(`Path=${attributes.path}`);
	if (attributes.httpOnly) parts.push('HttpOnly');
	if (attributes.secure) parts.push('Secure');
	if (attributes.sameSite) {
		parts.push(
			`SameSite=${attributes.sameSite.charAt(0).toUpperCase()}${attributes.sameSite.slice(1)}`
		);
	}
	return parts.join('; ');
}

// The response with `before` its own Set-Cookie headers and `after` them, each its own header.
function with_set_cookies(response: Response, before: string[], after: string[]): Response {
	if (before.length === 0 && after.length === 0) return response;

	const headers = new Headers(response.headers);
	headers.delete('set-cookie');
	for (const set_cookie of [...before, ...response.headers.getSetCookie(), ...after]) {
		headers.append('set-cookie', set_cookie);
	}
	return new Response(response.body, {
		status: response.status,
		statusText: response.statusText,
		headers
	});
}

async function sign_out(
	environment: LocalAuthEnvironment,
	request: Request,
	handle: HandleAuth
): Promise<Response> {
	request.signal.throwIfAborted();
	const carried = carried_profiles(request.headers.get('cookie'));
	const profiles = carried.length > 0 ? carried : [environment.use_secure_cookies === true];
	// Each pass reads its own copy of the one (small JSON) request body.
	const body = request.body ? await request.arrayBuffer() : null;
	const pass = (use_secure_cookies: boolean) => {
		// Cancellation must survive rebuilding the body and stop later profile mutations.
		request.signal.throwIfAborted();
		return handle(
			{ ...environment, use_secure_cookies },
			new Request(request.url, {
				method: request.method,
				headers: request.headers,
				body,
				signal: request.signal
			})
		);
	};
	const cleared: string[] = [];

	let index = 0;
	let response = await pass(profiles[0]);
	while (response.ok && index + 1 < profiles.length) {
		cleared.push(...response.headers.getSetCookie());
		await response.body?.cancel();
		index += 1;
		response = await pass(profiles[index]);
	}

	return with_set_cookies(response, cleared, []);
}

async function sign_in(
	environment: LocalAuthEnvironment,
	request: Request,
	handle: HandleAuth
): Promise<Response> {
	const names = cookie_names(request.headers.get('cookie'));
	const response = await handle(environment, request);
	const issued = response.headers
		.getSetCookie()
		.some((set_cookie) => set_cookie.startsWith(`${SESSION_COOKIE}=`));
	if (!response.ok || environment.use_secure_cookies || !issued) return response;
	if (!names.has(SECURE_SESSION_COOKIE)) return response;

	const expiring = profile_cookies(environment, true)
		.filter((cookie) => names.has(cookie.name))
		.map((cookie) => expiring_set_cookie(cookie.name, cookie.attributes));
	return with_set_cookies(response, [], expiring);
}

const SIGN_IN_PATHS = new Set(['/api/auth/sign-in/email', '/api/auth/sign-up/email']);

/**
 * Answers an auth API request with Better Auth (`handle`). In local mode it applies the rules above
 * to POST sign-out, sign-in, and sign-up; every other request, and every deployed one, goes
 * straight to `handle`.
 */
export function answer_local_auth(
	environment: AuthEnvironment,
	request: Request,
	handle: HandleAuth
): Promise<Response> {
	if (environment.is_local_development && request.method === 'POST') {
		const { pathname } = new URL(request.url);
		if (pathname === '/api/auth/sign-out') return sign_out(environment, request, handle);
		if (SIGN_IN_PATHS.has(pathname)) return sign_in(environment, request, handle);
	}
	return handle(environment, request);
}
