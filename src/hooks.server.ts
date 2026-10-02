import { building } from '$app/environment';
import { create_auth } from '$lib/server/auth';
import { for_local_site, get_auth_environment } from '$lib/server/env';
import { get_local_site, local_host_refusal, name_refused_origin } from '$lib/utils/local_hosts';
import { svelteKitHandler } from 'better-auth/svelte-kit';

import type { Handle } from '@sveltejs/kit';

export const handle: Handle = async ({ event, resolve }) => {
	event.locals.session = null;
	event.locals.user = null;
	event.locals.is_local_development = false;

	if (building || event.url.pathname === '/api/health') {
		return resolve(event);
	}

	let environment = get_auth_environment(event.platform?.env);
	const is_auth_path = event.url.pathname.startsWith('/api/auth/');

	if (environment.is_local_development) {
		const site = get_local_site(event.url.hostname, event.request.headers.get('cookie'));

		// Local mode has a passwordless developer account, so it must never answer a real hostname.
		if (!site) {
			const loopback_origin = new URL(environment.BETTER_AUTH_URL).origin;
			return new Response(local_host_refusal(event.url.hostname, loopback_origin), {
				status: 403,
				headers: { 'content-type': 'text/plain; charset=utf-8' }
			});
		}

		environment = for_local_site(environment, site);

		// Behind the local HTTPS proxy, and on app servers' calls through localhost, the request's
		// origin differs from https://auth.syntax.test, so svelteKitHandler wouldn't recognize these
		// paths. Better Auth handles them before the getSession below, which would otherwise refresh
		// the session first and keep get-session's refreshed cookie from reaching the app.
		if (site === 'syntax_test' && is_auth_path) {
			const response = await create_auth(environment).handler(event.request);
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
