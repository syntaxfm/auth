import { building } from '$app/environment';
import { create_auth } from '$lib/server/auth';
import { get_auth_environment } from '$lib/server/env';
import { svelteKitHandler } from 'better-auth/svelte-kit';

import type { Handle } from '@sveltejs/kit';

export const handle: Handle = async ({ event, resolve }) => {
	event.locals.session = null;
	event.locals.user = null;

	if (building || event.url.pathname === '/api/health') {
		return resolve(event);
	}

	const auth = create_auth(get_auth_environment(event.platform));
	event.locals.auth = auth;
	const session = await auth.api.getSession({
		headers: event.request.headers
	});

	if (session) {
		event.locals.session = session.session;
		event.locals.user = session.user;
	}

	return svelteKitHandler({ event, resolve, auth, building });
};
