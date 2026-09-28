import { getPlatformProxy } from 'wrangler';

import { create_auth } from '../src/lib/server/auth';
import { get_auth_environment } from '../src/lib/server/env';

interface RegistrationOptions {
	name: string;
	redirect_uris: string[];
	post_logout_redirect_uris: string[];
	scopes: string[];
	is_public: boolean;
	skip_consent: boolean;
	enable_end_session: boolean;
	is_remote: boolean;
}

function parse_arguments(args: string[]): RegistrationOptions {
	const options: RegistrationOptions = {
		name: '',
		redirect_uris: [],
		post_logout_redirect_uris: [],
		scopes: ['openid', 'profile', 'email', 'offline_access'],
		is_public: false,
		skip_consent: false,
		enable_end_session: false,
		is_remote: false
	};

	for (let index = 0; index < args.length; index += 1) {
		const argument = args[index];
		const value = args[index + 1];

		switch (argument) {
			case '--name':
				if (!value) throw new TypeError('--name requires a value.');
				options.name = value;
				index += 1;
				break;
			case '--redirect-uri':
				if (!value) throw new TypeError('--redirect-uri requires a value.');
				options.redirect_uris.push(new URL(value).toString());
				index += 1;
				break;
			case '--post-logout-redirect-uri':
				if (!value) throw new TypeError('--post-logout-redirect-uri requires a value.');
				options.post_logout_redirect_uris.push(new URL(value).toString());
				index += 1;
				break;
			case '--scope':
				if (!value) throw new TypeError('--scope requires a value.');
				options.scopes = value.split(' ').filter(Boolean);
				index += 1;
				break;
			case '--public':
				options.is_public = true;
				break;
			case '--skip-consent':
				options.skip_consent = true;
				break;
			case '--enable-end-session':
				options.enable_end_session = true;
				break;
			case '--remote':
				options.is_remote = true;
				break;
			default:
				throw new TypeError(`Unknown argument: ${argument}`);
		}
	}

	if (!options.name) throw new TypeError('--name is required.');
	if (!options.redirect_uris.length)
		throw new TypeError('At least one --redirect-uri is required.');

	return options;
}

const options = parse_arguments(process.argv.slice(2));
const platform = await getPlatformProxy<App.Platform['env']>({
	configPath: 'wrangler.jsonc',
	environment: options.is_remote ? 'oauth-registration' : 'local',
	persist: true,
	remoteBindings: options.is_remote
});
let registration_user_id: string | undefined;

try {
	// Both envs use a loopback URL, so Better Auth runs in local mode with email/password enabled.
	const auth = create_auth(get_auth_environment(platform.env));
	const nonce = crypto.randomUUID();
	const sign_up_response = await auth.api.signUpEmail({
		asResponse: true,
		body: {
			email: `oauth-registration-${nonce}@invalid.example`,
			name: 'OAuth Client Registration',
			password: `${crypto.randomUUID()}${crypto.randomUUID()}`
		}
	});
	const sign_up_body = (await sign_up_response.json()) as { user?: { id?: string } };
	registration_user_id = sign_up_body.user?.id;
	const session_cookie = sign_up_response.headers
		.getSetCookie()
		.find((cookie) => cookie.includes('session_token='))
		?.split(';', 1)[0];

	if (!sign_up_response.ok || !registration_user_id || !session_cookie) {
		throw new Error('Unable to create the temporary registration session.');
	}

	const client = await auth.api.adminCreateOAuthClient({
		headers: new Headers({ cookie: session_cookie }),
		body: {
			client_name: options.name,
			redirect_uris: options.redirect_uris,
			post_logout_redirect_uris: options.post_logout_redirect_uris.length
				? options.post_logout_redirect_uris
				: undefined,
			scope: options.scopes.join(' '),
			token_endpoint_auth_method: options.is_public ? 'none' : 'client_secret_basic',
			grant_types: ['authorization_code', 'refresh_token'],
			response_types: ['code'],
			type: options.is_public ? 'user-agent-based' : 'web',
			require_pkce: true,
			skip_consent: options.skip_consent,
			enable_end_session: options.enable_end_session,
			client_secret_expires_at: 0
		}
	});

	process.stdout.write(`${JSON.stringify({ ...client, user_id: null }, null, 2)}\n`);
} catch (registration_error) {
	console.error('OAuth client registration failed', registration_error);
	process.exitCode = 1;
} finally {
	if (registration_user_id) {
		await platform.env.DB.batch([
			platform.env.DB.prepare('UPDATE oauth_client SET user_id = NULL WHERE user_id = ?').bind(
				registration_user_id
			),
			platform.env.DB.prepare('DELETE FROM session WHERE user_id = ?').bind(registration_user_id),
			platform.env.DB.prepare('DELETE FROM account WHERE user_id = ?').bind(registration_user_id),
			platform.env.DB.prepare('DELETE FROM user WHERE id = ?').bind(registration_user_id)
		]);
	}

	await platform.dispose();
}
