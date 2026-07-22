import type { D1Database } from '@cloudflare/workers-types';
import type { Auth } from '$lib/server/auth';

declare global {
	namespace App {
		interface Locals {
			auth: Auth;
			session: import('better-auth').Session | null;
			user: import('better-auth').User | null;
		}

		interface Platform {
			env: {
				DB: D1Database;
				BETTER_AUTH_URL: string;
				BETTER_AUTH_SECRET: string;
				GITHUB_CLIENT_ID: string;
				GITHUB_CLIENT_SECRET: string;
			};
		}
	}
}

export {};
