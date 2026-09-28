import { building } from '$app/environment';
import { create_auth } from '$lib/server/auth';
import { get_auth_environment } from '$lib/server/env';
import { is_loopback_hostname } from '$lib/utils/loopback';
import { svelteKitHandler } from 'better-auth/svelte-kit';

import type { Handle } from '@sveltejs/kit';

export const handle: Handle = async ({ event, resolve }) => {
	event.locals.session = null;
	event.locals.user = null;
	event.locals.is_local_development = false;

	if (building || event.url.pathname === '/api/health') {
		return resolve(event);
	}

	const environment = get_auth_environment(event.platform?.env);

	// Local mode has a passwordless developer account, so it must never answer a real hostname.
	if (environment.is_local_development && !is_loopback_hostname(event.url.hostname)) {
		return new Response('Local Syntax Auth only serves localhost', { status: 403 });
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

	return svelteKitHandler({ event, resolve, auth, building });
};
