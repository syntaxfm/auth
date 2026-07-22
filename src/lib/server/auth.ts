import { oauthProvider } from '@better-auth/oauth-provider';
import { drizzleAdapter } from '@better-auth/drizzle-adapter';
import { betterAuth } from 'better-auth';
import { jwt } from 'better-auth/plugins';
import { drizzle } from 'drizzle-orm/d1';

import * as schema from './db/schema';
import type { AuthEnvironment } from './env';

interface CreateAuthOptions {
	enable_email_password?: boolean;
}

export function create_auth(env: AuthEnvironment, options: CreateAuthOptions = {}) {
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
		emailAndPassword: options.enable_email_password ? { enabled: true } : undefined,
		trustedOrigins: ['https://syntax.fm', 'https://*.syntax.fm', better_auth_origin],
		advanced: env.AUTH_COOKIE_DOMAIN
			? {
					crossSubDomainCookies: {
						enabled: true,
						domain: env.AUTH_COOKIE_DOMAIN
					}
				}
			: undefined,
		socialProviders: {
			github: {
				clientId: env.GITHUB_CLIENT_ID,
				clientSecret: env.GITHUB_CLIENT_SECRET
			}
		},
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
