import { oauthProvider } from '@better-auth/oauth-provider';
import { drizzleAdapter } from '@better-auth/drizzle-adapter';
import { betterAuth, type BetterAuthOptions } from 'better-auth';
import { jwt } from 'better-auth/plugins';
import { drizzle } from 'drizzle-orm/d1';

import * as schema from './db/schema';
import type { AuthEnvironment } from './env';
import { LOCAL_DEVELOPER } from './local_developer';
import { get_oauth_valid_audiences } from './oauth_audiences';

// Locally: Syntax Auth's own loopback origin, apps on any localhost port, and the one browser origin
// the development proxy vouched for on this request (src/lib/server/dev_proxy.ts).
export function get_trusted_origins(env: AuthEnvironment): string[] {
	const better_auth_origin = new URL(env.BETTER_AUTH_URL).origin;

	if (!env.is_local_development) {
		return ['https://syntax.fm', 'https://*.syntax.fm', better_auth_origin];
	}

	return [
		better_auth_origin,
		'http://localhost:*',
		'http://127.0.0.1:*',
		...(env.trusted_dev_origin ? [env.trusted_dev_origin] : [])
	];
}

// Deployed: the shared `.syntax.fm` cookie. Locally: a host-only cookie, named and marked `__Secure-`
// for a browser on https. It keeps that name and attribute on app servers' http://localhost calls,
// because Better Auth reads only the configured name.
export function get_cookie_options(env: AuthEnvironment): BetterAuthOptions['advanced'] {
	if (env.is_local_development) return { useSecureCookies: env.use_secure_cookies === true };

	return env.AUTH_COOKIE_DOMAIN
		? { crossSubDomainCookies: { enabled: true, domain: env.AUTH_COOKIE_DOMAIN } }
		: undefined;
}

export function create_auth(env: AuthEnvironment) {
	const database = drizzle(env.DB, { schema });
	const better_auth_origin = new URL(env.BETTER_AUTH_URL).origin;

	return betterAuth({
		appName: 'Syntax',
		baseURL: env.BETTER_AUTH_URL,
		basePath: '/api/auth',
		secret: env.BETTER_AUTH_SECRET,
		database: drizzleAdapter(database, {
			provider: 'sqlite',
			schema
		}),
		disabledPaths: ['/token'],
		trustedOrigins: get_trusted_origins(env),
		advanced: get_cookie_options(env),
		// Locally, email/password backs the one-click developer sign-in instead of GitHub.
		...(env.is_local_development
			? {
					emailAndPassword: { enabled: true },
					// Better Auth rate-limits production builds only, and the Docker image serves one.
					// Locally every app shares one IP-less bucket, so limits would only block repeat
					// developer sign-ins.
					rateLimit: { enabled: false },
					databaseHooks: {
						user: {
							create: {
								before: async (user) =>
									user.email === LOCAL_DEVELOPER.email
										? { data: { ...user, id: LOCAL_DEVELOPER.id } }
										: { data: user }
							}
						}
					}
				}
			: {
					socialProviders: {
						github: {
							clientId: env.GITHUB_CLIENT_ID,
							clientSecret: env.GITHUB_CLIENT_SECRET
						}
					}
				}),
		plugins: [
			jwt({
				disableSettingJwtHeader: true
			}),
			oauthProvider({
				loginPage: '/sign-in',
				consentPage: '/consent',
				scopes: ['openid', 'profile', 'email', 'offline_access'],
				allowDynamicClientRegistration: false,
				allowUnauthenticatedClientRegistration: false,
				// Without this, Better Auth accepts only its own base URL as a token `resource`.
				validAudiences: get_oauth_valid_audiences(better_auth_origin),
				silenceWarnings: {
					oauthAuthServerConfig: true
				}
			})
		]
	});
}

export type Auth = ReturnType<typeof create_auth>;
