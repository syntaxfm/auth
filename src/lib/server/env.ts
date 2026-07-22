import type { D1Database } from '@cloudflare/workers-types';

export interface AuthEnvironment {
	DB: D1Database;
	BETTER_AUTH_URL: string;
	BETTER_AUTH_SECRET: string;
	GITHUB_CLIENT_ID: string;
	GITHUB_CLIENT_SECRET: string;
}

type RequiredStringKey =
	'BETTER_AUTH_URL' | 'BETTER_AUTH_SECRET' | 'GITHUB_CLIENT_ID' | 'GITHUB_CLIENT_SECRET';

function require_string(env: App.Platform['env'], name: RequiredStringKey): string {
	const value = env[name]?.trim();

	if (!value) {
		throw new Error(`Missing required Cloudflare Worker variable or secret: ${name}`);
	}

	return value;
}

export function get_auth_environment(platform: App.Platform | undefined): AuthEnvironment {
	if (!platform?.env?.DB) {
		throw new Error('Missing required Cloudflare D1 binding: DB');
	}

	return {
		DB: platform.env.DB,
		BETTER_AUTH_URL: require_string(platform.env, 'BETTER_AUTH_URL'),
		BETTER_AUTH_SECRET: require_string(platform.env, 'BETTER_AUTH_SECRET'),
		GITHUB_CLIENT_ID: require_string(platform.env, 'GITHUB_CLIENT_ID'),
		GITHUB_CLIENT_SECRET: require_string(platform.env, 'GITHUB_CLIENT_SECRET')
	};
}
