import type { D1Database } from '@cloudflare/workers-types';

// Relative so scripts/register_oauth_client.ts can load this module outside SvelteKit.
import { is_loopback_hostname } from '../utils/loopback';

// Only used when Syntax Auth runs on a loopback URL, where sessions never leave the machine.
const LOCAL_DEVELOPMENT_SECRET = 'syntax-auth-local-development-secret-never-used-in-production';

interface SharedAuthEnvironment {
	DB: D1Database;
	BETTER_AUTH_URL: string;
	AUTH_COOKIE_DOMAIN?: string;
	BETTER_AUTH_SECRET: string;
}

export interface LocalAuthEnvironment extends SharedAuthEnvironment {
	is_local_development: true;
	// Per request (src/lib/server/dev_proxy.ts): the browser origin the development proxy vouched
	// for, and whether the session cookie is the `__Secure-` one. Cookies never get a Domain.
	trusted_dev_origin?: string;
	use_secure_cookies?: boolean;
}

interface DeployedAuthEnvironment extends SharedAuthEnvironment {
	is_local_development: false;
	GITHUB_CLIENT_ID: string;
	GITHUB_CLIENT_SECRET: string;
}

export type AuthEnvironment = LocalAuthEnvironment | DeployedAuthEnvironment;

type RequiredStringKey =
	'BETTER_AUTH_URL' | 'BETTER_AUTH_SECRET' | 'GITHUB_CLIENT_ID' | 'GITHUB_CLIENT_SECRET';

function require_string(env: App.Platform['env'], name: RequiredStringKey): string {
	const value = env[name]?.trim();

	if (!value) {
		throw new Error(`Missing required Cloudflare Worker variable or secret: ${name}`);
	}

	return value;
}

function optional_string(value: string | undefined): string | undefined {
	return value?.trim() || undefined;
}

export function get_auth_environment(env: App.Platform['env'] | undefined): AuthEnvironment {
	if (!env?.DB) {
		throw new Error('Missing required Cloudflare D1 binding: DB');
	}

	const better_auth_url = require_string(env, 'BETTER_AUTH_URL');
	const auth_cookie_domain = optional_string(env.AUTH_COOKIE_DOMAIN);

	// A shared cookie domain means a deployed service, even if the URL is misconfigured.
	if (is_loopback_hostname(new URL(better_auth_url).hostname) && !auth_cookie_domain) {
		return {
			is_local_development: true,
			DB: env.DB,
			BETTER_AUTH_URL: better_auth_url,
			BETTER_AUTH_SECRET: optional_string(env.BETTER_AUTH_SECRET) ?? LOCAL_DEVELOPMENT_SECRET
		};
	}

	return {
		is_local_development: false,
		DB: env.DB,
		BETTER_AUTH_URL: better_auth_url,
		AUTH_COOKIE_DOMAIN: auth_cookie_domain,
		BETTER_AUTH_SECRET: require_string(env, 'BETTER_AUTH_SECRET'),
		GITHUB_CLIENT_ID: require_string(env, 'GITHUB_CLIENT_ID'),
		GITHUB_CLIENT_SECRET: require_string(env, 'GITHUB_CLIENT_SECRET')
	};
}
