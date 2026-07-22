import { oauthProviderClient } from '@better-auth/oauth-provider/client';
import { createAuthClient } from 'better-auth/svelte';

export const auth_client = createAuthClient({
	plugins: [oauthProviderClient()]
});
