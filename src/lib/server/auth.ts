import { oauthProvider } from '@better-auth/oauth-provider';
import { drizzleAdapter } from '@better-auth/drizzle-adapter';
import { betterAuth } from 'better-auth';
import { jwt } from 'better-auth/plugins';
import { drizzle } from 'drizzle-orm/d1';

import * as schema from './db/schema';
import type { AuthEnvironment } from './env';
import { LOCAL_DEVELOPER } from './local_developer';

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
		trustedOrigins: env.is_local_development
			? [better_auth_origin, 'http://localhost:*', 'http://127.0.0.1:*']
			: ['https://syntax.fm', 'https://*.syntax.fm', better_auth_origin],
		advanced: env.AUTH_COOKIE_DOMAIN
			? {
					crossSubDomainCookies: {
						enabled: true,
						domain: env.AUTH_COOKIE_DOMAIN
					}
				}
			: undefined,
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
				silenceWarnings: {
					oauthAuthServerConfig: true
				}
			})
		]
	});
}

export type Auth = ReturnType<typeof create_auth>;
