// What local Syntax Auth reads from a request to pick its cookies and trusted origin, in local mode
// only. Apps reach it two ways:
//
// - Their servers call http://localhost:37960 directly (get-session, sign-out) with the browser's
//   Cookie header. The cookie's name says which kind it is: `__Secure-better-auth.session_token`
//   for a browser on https, `better-auth.session_token` otherwise. Neither has a Domain. A browser
//   may hold both; src/lib/server/local_session_cookies.ts decides what sign-out and sign-in do then.
// - The development proxy in @syntaxfm/auth-local (packages/auth-local/gateway.js) forwards a
//   browser's sign-in and sign-out from the app's own address, naming the browser's origin, as it
//   checked it, in DEV_ORIGIN_HEADER. Browsers can't send that header here: it isn't a simple
//   header, and local Syntax Auth answers no CORS preflight.
//
// The header counts only when it is a bare http or https origin and equals the request's Origin (if
// it has one); anything else is refused, never ignored. Deployed Syntax Auth never reads it.
// Relative imports, so unit tests load this module outside SvelteKit.
import { has_cookie } from '../utils/local_hosts';
import type { AuthEnvironment } from './env';

export const DEV_ORIGIN_HEADER = 'x-syntax-auth-dev-origin';
// Better Auth's session cookie name when `useSecureCookies` is on.
export const SECURE_SESSION_COOKIE = '__Secure-better-auth.session_token';

const MAX_ORIGIN_LENGTH = 2_048;

export interface LocalRequestContext {
	// The browser's origin, as the development proxy checked it, or null for a direct call.
	dev_origin: string | null;
	use_secure_cookies: boolean;
}

// A bare http or https origin exactly as browsers write it: lowercase, no default port, no
// credentials, path, query, or fragment, and no wildcard.
export function parse_dev_origin(value: string): string | null {
	if (value.length === 0 || value.length > MAX_ORIGIN_LENGTH) return null;

	try {
		const url = new URL(value);
		if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
		// Plain host characters only: Better Auth reads `*` and `?` in a trusted origin as wildcards.
		if (!/^(?:\[[0-9a-f:.]+\]|[a-z0-9._-]+)$/.test(url.hostname)) return null;
		return url.origin === value ? value : null;
	} catch {
		return null;
	}
}

function refuse(status: number, message: string): Response {
	return new Response(message, {
		status,
		headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' }
	});
}

export function read_local_request(
	request: Request
): { context: LocalRequestContext } | { refusal: Response } {
	const header = request.headers.get(DEV_ORIGIN_HEADER);

	if (header === null) {
		return {
			context: {
				dev_origin: null,
				use_secure_cookies: has_cookie(request.headers.get('cookie'), SECURE_SESSION_COOKIE)
			}
		};
	}

	const dev_origin = parse_dev_origin(header);
	if (!dev_origin) {
		return {
			refusal: refuse(
				400,
				`Local Syntax Auth refused a request whose ${DEV_ORIGIN_HEADER} header isn't a bare http or https origin.`
			)
		};
	}

	const origin = request.headers.get('origin');
	if (origin !== null && origin !== dev_origin) {
		return {
			refusal: refuse(
				403,
				`Local Syntax Auth refused a request whose ${DEV_ORIGIN_HEADER} header doesn't match its Origin.`
			)
		};
	}

	return { context: { dev_origin, use_secure_cookies: dev_origin.startsWith('https:') } };
}

// The request's environment: local mode configured for this request, or the deployed environment
// unchanged, whatever the request carries.
export function for_request(
	environment: AuthEnvironment,
	request: Request
): { environment: AuthEnvironment } | { refusal: Response } {
	if (!environment.is_local_development) return { environment };

	const read = read_local_request(request);
	if ('refusal' in read) return read;

	return {
		environment: {
			...environment,
			trusted_dev_origin: read.context.dev_origin ?? undefined,
			use_secure_cookies: read.context.use_secure_cookies
		}
	};
}
