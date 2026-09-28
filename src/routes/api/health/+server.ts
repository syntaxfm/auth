import type { RequestHandler } from './$types';

export const GET: RequestHandler = () =>
	Response.json(
		{ status: 'ok', service: 'syntax-auth' },
		{
			headers: {
				'cache-control': 'no-store'
			}
		}
	);
