import { redirect } from '@sveltejs/kit';

import type { PageServerLoad } from './$types';

function is_loopback_hostname(hostname: string): boolean {
	return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
}

function get_safe_return_to(value: string | null, better_auth_url: string | undefined) {
	if (!value) return null;

	let return_url: URL;

	try {
		return_url = new URL(value);
	} catch {
		return null;
	}

	if (return_url.username || return_url.password) return null;

	if (
		return_url.protocol === 'https:' &&
		(return_url.hostname === 'syntax.fm' || return_url.hostname.endsWith('.syntax.fm'))
	) {
		return return_url.href;
	}

	if (!better_auth_url) return null;

	try {
		const auth_url = new URL(better_auth_url);

		if (is_loopback_hostname(auth_url.hostname) && return_url.origin === auth_url.origin) {
			return return_url.href;
		}
	} catch {
		return null;
	}

	return null;
}

export const load: PageServerLoad = ({ locals, platform, url }) => {
	const return_to = get_safe_return_to(
		url.searchParams.get('return_to'),
		platform?.env.BETTER_AUTH_URL
	);

	if (locals.session && locals.user && return_to) {
		redirect(303, return_to);
	}

	return {
		user: locals.user,
		return_to
	};
};
