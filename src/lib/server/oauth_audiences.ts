// The audiences Syntax Auth issues OAuth access tokens for (RFC 8707 `resource`). The token
// endpoint refuses any other `resource`, so a token is only ever usable where it was meant to go.
// - Syntax Auth's own API, which is Better Auth's default (its base URL plus `/api/auth`).
// - Syntax Lab's MCP endpoint: members' own agents (Claude Code, pi) sign in here and send the
//   token to Lab, which verifies it against this service's published keys
//   (syntax-lab docs/tech/agent-access.md, "Built: the MCP endpoint").
export const SYNTAX_LAB_MCP_AUDIENCE = 'https://lab.syntax.fm/mcp';

// Lab's dev server, on its documented port 1337. Agents send the protected-resource URL as
// `resource`, so a Lab dev server on another port or host gets "requested resource invalid".
// Only local Syntax Auth issues tokens for it.
export const SYNTAX_LAB_LOCAL_MCP_AUDIENCE = 'http://localhost:1337/mcp';

export function get_oauth_valid_audiences(
	better_auth_origin: string,
	is_local_development: boolean
): string[] {
	return [
		`${better_auth_origin}/api/auth`,
		SYNTAX_LAB_MCP_AUDIENCE,
		...(is_local_development ? [SYNTAX_LAB_LOCAL_MCP_AUDIENCE] : [])
	];
}
