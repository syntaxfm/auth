import { oauthProviderOpenIdConfigMetadata } from '@better-auth/oauth-provider';

import type { RequestHandler } from './$types';

export const GET: RequestHandler = ({ locals, request }) =>
	oauthProviderOpenIdConfigMetadata(locals.auth)(request);
