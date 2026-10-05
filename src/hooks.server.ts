import { building, dev } from '$app/environment';
import { create_auth } from '$lib/server/auth';
import { refuse_cross_site_form } from '$lib/server/cross_site_forms';
import { for_request } from '$lib/server/dev_proxy';
import { get_auth_environment } from '$lib/server/env';
import { answer_local_auth } from '$lib/server/local_session_cookies';
import { local_host_refusal, name_refused_origin } from '$lib/utils/local_hosts';
import { is_loopback_hostname } from '$lib/utils/loopback';
import { svelteKitHandler } from 'better-auth/svelte-kit';

import type { Handle } from '@sveltejs/kit';

export const handle: Handle = async ({ event, resolve }) => {
	event.locals.session = null;
	event.locals.user = null;
	event.locals.is_local_development = false;

	// SvelteKit's own cross-site form check, run first, in built servers as SvelteKit ran it,
	// except on the endpoints native OAuth clients post to (src/lib/server/cross_site_forms.ts).
	if (!dev) {
		const refusal = refuse_cross_site_form(event.request);
		if (refusal) return refusal;
	}

	if (building || event.url.pathname === '/api/health') {
		return resolve(event);
	}

	let environment = get_auth_environment(event.platform?.env);
	const is_auth_path = event.url.pathname.startsWith('/api/auth/');

	if (environment.is_local_development) {
		// Local mode has a passwordless developer account, so it must never answer a real hostname.
		if (!is_loopback_hostname(event.url.hostname)) {
			const loopback_origin = new URL(environment.BETTER_AUTH_URL).origin;
			return new Response(local_host_refusal(event.url.hostname, loopback_origin), {
				status: 403,
				headers: { 'content-type': 'text/plain; charset=utf-8' }
			});
		}

		// Per request: the cookie kind and the origin an app's development proxy vouched for
		// (src/lib/server/dev_proxy.ts). Malformed or mismatched proxy metadata is refused.
		const local = for_request(environment, event.request);
		if ('refusal' in local) return local.refusal;
		environment = local.environment;

		// The auth API, as svelteKitHandler below would route it, but before the getSession below,
		// which would refresh the session first and keep get-session's refreshed cookie from
		// reaching the app. Sign-out ends every session cookie the browser sent, and a sign-in
		// expires an older one read before its own (src/lib/server/local_session_cookies.ts).
		if (is_auth_path && event.url.origin === new URL(environment.BETTER_AUTH_URL).origin) {
			const response = await answer_local_auth(environment, event.request, (env, request) =>
				create_auth(env).handler(request)
			);
			return name_refused_origin(response, event.request, true);
		}
	}

	const auth = create_auth(environment);
	event.locals.auth = auth;
	event.locals.is_local_development = environment.is_local_development;
	const session = await auth.api.getSession({
		headers: event.request.headers
	});

	if (session) {
		event.locals.session = session.session;
		event.locals.user = session.user;
	}

	const response = await svelteKitHandler({ event, resolve, auth, building });
	return is_auth_path
		? name_refused_origin(response, event.request, environment.is_local_development)
		: response;
};
