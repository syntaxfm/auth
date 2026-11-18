import { error, redirect } from '@sveltejs/kit';

import { get_registered_redirect_host } from '$lib/utils/oauth_redirect';

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

	// Better Auth's public client fields leave out redirect URIs, so read them as its authorize
	// endpoint does.
	const { adapter } = await locals.auth.$context;
	const registered_client = await adapter.findOne<{ redirectUris: string[] }>({
		model: 'oauthClient',
		where: [{ field: 'clientId', value: client_id }]
	});
	const redirect_host = get_registered_redirect_host(
		url.searchParams.get('redirect_uri'),
		registered_client?.redirectUris ?? []
	);

	if (!redirect_host) {
		error(400, 'Invalid OAuth consent request.');
	}

	return {
		client_name: client.name ?? 'Application',
		redirect_host,
		scopes: (url.searchParams.get('scope') ?? '')
			.split(' ')
			.map((scope) => scope.trim())
			.filter(Boolean),
		user: locals.user
	};
};
