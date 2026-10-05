// SvelteKit refuses a cross-site form post (a POST, PUT, PATCH, or DELETE with a form content
// type whose Origin isn't this site's), to stop CSRF. Native OAuth clients, such as Claude Code
// and pi signing in to Syntax Lab's MCP endpoint, post forms to the token and revocation endpoints
// from no website, so they send no Origin and SvelteKit's check refused them with 403. Its config
// can't exempt a path, so svelte.config.js turns it off and hooks.server.ts runs this same check
// instead, on every path but those two. They need no CSRF protection: they read no cookie, and a
// request only works with what the caller already holds (an authorization code with its PKCE
// verifier, a refresh token, or the token to revoke), never with a signed-in browser's session.

// RFC 6749's token endpoint and RFC 7009's revocation endpoint, as Better Auth's OAuth provider
// serves them (see /.well-known/oauth-authorization-server).
const NATIVE_CLIENT_FORM_PATHS = new Set(['/api/auth/oauth2/token', '/api/auth/oauth2/revoke']);

// The content types SvelteKit treats as form submissions (@sveltejs/kit src/utils/http.js).
const FORM_CONTENT_TYPES = new Set([
	'application/x-www-form-urlencoded',
	'multipart/form-data',
	'text/plain',
	'application/x-sveltekit-formdata'
]);

const CHECKED_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function is_form_content_type(request: Request): boolean {
	const content_type = request.headers.get('content-type')?.split(';', 1)[0].trim() ?? '';
	return FORM_CONTENT_TYPES.has(content_type.toLowerCase());
}

/**
 * SvelteKit's refusal of a cross-site form submission, with its status and message, or null when
 * the request may go on. A form post to the token or revocation endpoint always goes on.
 */
export function refuse_cross_site_form(request: Request, url: URL): Response | null {
	if (NATIVE_CLIENT_FORM_PATHS.has(url.pathname)) return null;
	if (!CHECKED_METHODS.has(request.method) || !is_form_content_type(request)) return null;
	if (request.headers.get('origin') === url.origin) return null;

	const message = `Cross-site ${request.method} form submissions are forbidden`;

	return request.headers.get('accept') === 'application/json'
		? Response.json({ message }, { status: 403 })
		: new Response(message, {
				status: 403,
				headers: { 'content-type': 'text/plain;charset=UTF-8' }
			});
}
