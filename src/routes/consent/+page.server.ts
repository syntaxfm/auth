import { error, redirect } from '@sveltejs/kit';

import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, request, url }) => {
	if (!locals.user) {
		redirect(303, `/sign-in${url.search}`);
	}

	const client_id = url.searchParams.get('client_id');

	if (!client_id) {
		error(400, 'Invalid OAuth consent request.');
	}

	const client = await locals.auth.api
		.getOAuthClientPublic({
			headers: request.headers,
			query: { client_id }
		})
		.catch((request_error: unknown) => {
			console.error('Unable to load the OAuth client for consent', request_error);
			error(400, 'Invalid OAuth consent request.');
		});

	if (!client) {
		error(400, 'Unknown OAuth client.');
	}

	return {
		client_name: client.name ?? 'Application',
		scopes: (url.searchParams.get('scope') ?? '')
			.split(' ')
			.map((scope) => scope.trim())
			.filter(Boolean),
		user: locals.user
	};
};
