// OAuth clients that only local Syntax Auth has, seeded by scripts/seed_local_oauth_clients.ts.
// Deployed Syntax Auth registers its clients with scripts/register_oauth_client.ts instead.
//
// Syntax Lab MCP (local): members' own agents (Claude Code, pi) sign in with it to Lab's dev server
// at `http://localhost:1337/mcp`. Its ID is fixed so every machine and Lab's docs use the same
// `claude mcp add` command; a public client's ID is not a secret. The other values are the ones
// production's Syntax Lab MCP client was registered with (`pnpm oauth:register --public`):
// Claude Code's fixed callback port 41337, and `127.0.0.1` on any port (RFC 8252) for pi.
export const LOCAL_SYNTAX_LAB_MCP_CLIENT = {
	client_id: 'syntax-lab-mcp-local',
	client_name: 'Syntax Lab MCP (local)',
	redirect_uris: ['http://localhost:41337/callback', 'http://127.0.0.1/callback'],
	scopes: ['openid', 'profile', 'email', 'offline_access'],
	token_endpoint_auth_method: 'none',
	type: 'user-agent-based',
	grant_types: ['authorization_code', 'refresh_token'],
	response_types: ['code'],
	require_pkce: true,
	skip_consent: false,
	enable_end_session: false
} as const;
