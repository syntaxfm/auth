// The host an OAuth authorization request returns to, shown on the consent page because a client
// that registered itself chose its own name. Null unless the client registered a redirect URI on
// that host with the same scheme. Better Auth's authorize endpoint checks the exact URI again (any
// port on a loopback IP, RFC 8252) before it issues a code, and the consent page's query is
// signed, so the request can return nowhere else.
export function get_registered_redirect_host(
	redirect_uri: string | null,
	registered_redirect_uris: readonly string[]
): string | null {
	if (!redirect_uri || !URL.canParse(redirect_uri)) return null;

	const requested = new URL(redirect_uri);
	const is_registered = registered_redirect_uris.some((registered_uri) => {
		if (!URL.canParse(registered_uri)) return false;

		const registered = new URL(registered_uri);

		return registered.protocol === requested.protocol && registered.hostname === requested.hostname;
	});

	return is_registered ? requested.host : null;
}
