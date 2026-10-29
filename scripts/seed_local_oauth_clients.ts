// Seeds the OAuth clients only local Syntax Auth has (src/lib/server/local_oauth_clients.ts) into
// the local D1, after `pnpm d1:migrate:local` in `pnpm dev` and in the Docker image. It writes the
// row itself because Better Auth's `adminCreateOAuthClient` always generates a random client ID.
// An upsert on the client ID, so it can run on every start and later changes reach existing local
// databases.
import { drizzle } from 'drizzle-orm/d1';
import { getPlatformProxy } from 'wrangler';

import { oauthClient } from '../src/lib/server/db/schema';
import { get_auth_environment } from '../src/lib/server/env';
import { LOCAL_SYNTAX_LAB_MCP_CLIENT } from '../src/lib/server/local_oauth_clients';

// Only the `local` env, never remote bindings: this script must never write a deployed database.
const platform = await getPlatformProxy<App.Platform['env']>({
	configPath: 'wrangler.jsonc',
	environment: 'local',
	persist: true,
	remoteBindings: false
});

try {
	const env = get_auth_environment(platform.env);
	if (!env.is_local_development) {
		throw new Error(
			`Local OAuth clients are seeded only into local Syntax Auth, not ${env.BETTER_AUTH_URL}.`
		);
	}

	const client = LOCAL_SYNTAX_LAB_MCP_CLIENT;
	const now = new Date();
	const client_fields = {
		name: client.client_name,
		redirectUris: [...client.redirect_uris],
		scopes: [...client.scopes],
		tokenEndpointAuthMethod: client.token_endpoint_auth_method,
		type: client.type,
		public: true,
		grantTypes: [...client.grant_types],
		responseTypes: [...client.response_types],
		requirePKCE: client.require_pkce,
		skipConsent: client.skip_consent,
		enableEndSession: client.enable_end_session,
		disabled: false,
		updatedAt: now
	};

	await drizzle(env.DB)
		.insert(oauthClient)
		.values({ id: client.client_id, clientId: client.client_id, createdAt: now, ...client_fields })
		.onConflictDoUpdate({ target: oauthClient.clientId, set: client_fields });

	console.log(`Seeded the local OAuth client ${client.client_id}`);
} catch (seed_error) {
	console.error('Seeding local OAuth clients failed', seed_error);
	process.exitCode = 1;
} finally {
	await platform.dispose();
}
