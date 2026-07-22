import { oauthProviderAuthServerMetadata } from '@better-auth/oauth-provider';

import type { RequestHandler } from './$types';

export const GET: RequestHandler = ({ locals, request }) =>
	oauthProviderAuthServerMetadata(locals.auth)(request);
