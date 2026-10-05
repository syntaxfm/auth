// The names local Syntax Auth answers: loopback only. Browsers on any other address (a LAN or
// Tailscale address, or a developer's own HTTPS name) sign in through the app they are using, whose
// development proxy (@syntaxfm/auth-local) calls http://localhost:37960 for them; app servers call
// it there directly.
// A relative import, because scripts/register_oauth_client.ts loads this module outside SvelteKit.
import { is_loopback_hostname } from './loopback';

export function has_cookie(cookie_header: string | null, name: string): boolean {
	if (!cookie_header) return false;

	return cookie_header.split(';').some((pair) => pair.split('=', 1)[0].trim() === name);
}

/**
 * An `https://syntax.test` or `https://*.syntax.test` URL without credentials.
 * @deprecated Kept only for the sign-in page's existing local `return_to` rule
 * (src/routes/sign-in/+page.server.ts), unchanged. Nothing sets up these names any more; don't use
 * it for anything new.
 */
export function is_syntax_test_app_url(url: URL): boolean {
	if (url.protocol !== 'https:' || url.username || url.password) return false;

	return url.hostname === 'syntax.test' || url.hostname.endsWith('.syntax.test');
}

export function local_host_refusal(hostname: string, loopback_origin: string): string {
	return `Local Syntax Auth answers only localhost, 127.0.0.1, and [::1], so it refused this request for "${hostname}". Open ${loopback_origin} instead, or sign in through your app's own /__syntax_auth/sign-in.`;
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
	return is_loopback_hostname(hostname);
}

// Matches the local trustedOrigins in src/lib/server/auth.ts: their `:*` patterns need a port.
export function local_origin_refusal(origin: string): string {
	return `Local Syntax Auth refused a request from origin "${origin}": it accepts only http://localhost:<port> and http://127.0.0.1:<port>. Apps on any other address sign in and out through their own /__syntax_auth/ paths (@syntaxfm/auth-local).`;
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
