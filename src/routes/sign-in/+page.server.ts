import { redirect } from '@sveltejs/kit';

import { LOCAL_DEVELOPER } from '$lib/server/local_developer';
import { is_syntax_test_app_url } from '$lib/utils/local_hosts';
import { is_loopback_hostname } from '$lib/utils/loopback';

import type { PageServerLoad } from './$types';

function get_safe_return_to(value: string | null, is_local_development: boolean) {
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

	if (
		is_local_development &&
		return_url.protocol === 'http:' &&
		is_loopback_hostname(return_url.hostname)
	) {
		return return_url.href;
	}

	if (is_local_development && is_syntax_test_app_url(return_url)) {
		return return_url.href;
	}

	return null;
}

export const load: PageServerLoad = ({ locals, url }) => {
	const return_to = get_safe_return_to(
		url.searchParams.get('return_to'),
		locals.is_local_development
	);

	if (locals.session && locals.user && return_to) {
		redirect(303, return_to);
	}

	return {
		user: locals.user,
		return_to,
		local_developer: locals.is_local_development ? LOCAL_DEVELOPER : null
	};
};
