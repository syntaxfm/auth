// Which local sessions a sign-out ends and which old cookie a sign-in expires, against the installed
// Better Auth itself (with its in-memory database instead of D1, and the same cookie and origin
// settings as src/lib/server/auth.ts), then the rules' edges with a stand-in.
// src/hooks.server.test.ts covers the same flows end to end through a built local Syntax Auth.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { D1Database } from '@cloudflare/workers-types';
import { betterAuth } from 'better-auth';
import { memoryAdapter } from 'better-auth/adapters/memory';

import { get_cookie_options, get_trusted_origins } from './auth';
import { DEV_ORIGIN_HEADER, SECURE_SESSION_COOKIE, for_request } from './dev_proxy';
import type { AuthEnvironment } from './env';
import {
	SESSION_COOKIE,
	answer_local_auth,
	carried_profiles,
	expiring_set_cookie
} from './local_session_cookies';
import { LOCAL_DEVELOPER } from './local_developer';

const LOCAL: AuthEnvironment = {
	is_local_development: true,
	DB: {} as D1Database,
	BETTER_AUTH_URL: 'http://localhost:37960',
	BETTER_AUTH_SECRET: 'local-session-cookies-test-secret-of-enough-length'
};
const HTTP_ORIGIN = 'http://lab.example.dev';
const HTTPS_ORIGIN = 'https://lab.example.dev';

// One local Syntax Auth: a database shared by every request, Better Auth made per request.
function start_local_auth() {
	const database: Record<string, Record<string, unknown>[]> = {
		user: [],
		session: [],
		account: [],
		verification: []
	};
	const handle = (environment: AuthEnvironment, request: Request) =>
		betterAuth({
			baseURL: environment.BETTER_AUTH_URL,
			basePath: '/api/auth',
			secret: environment.BETTER_AUTH_SECRET,
			database: memoryAdapter(database),
			trustedOrigins: get_trusted_origins(environment),
			advanced: get_cookie_options(environment),
			emailAndPassword: { enabled: true },
			rateLimit: { enabled: false },
			databaseHooks: {
				user: {
					create: { before: async (user) => ({ data: { ...user, id: LOCAL_DEVELOPER.id } }) }
				}
			},
			logger: { disabled: true }
		}).handler(request);

	// As src/hooks.server.ts answers the auth API locally.
	const send = (
		path: string,
		{ method = 'POST', dev_origin, cookie, body }: Record<string, string | undefined> = {}
	) => {
		const request = new Request(`${LOCAL.BETTER_AUTH_URL}${path}`, {
			method,
			headers: {
				...(dev_origin ? { origin: dev_origin, [DEV_ORIGIN_HEADER]: dev_origin } : {}),
				...(cookie ? { cookie } : {}),
				...(body ? { 'content-type': 'application/json' } : {})
			},
			body
		});
		const local = for_request(LOCAL, request);
		assert.ok('environment' in local);
		return answer_local_auth(local.environment, request, handle);
	};

	// A browser's sign-in from `dev_origin` (an account on a fresh database), as the proxy sends it.
	const sign_in = async (dev_origin: string, cookie?: string) => {
		const { email, password, name } = LOCAL_DEVELOPER;
		let reply = await send('/api/auth/sign-in/email', {
			dev_origin,
			cookie,
			body: JSON.stringify({ email, password })
		});
		if (reply.status === 401) {
			reply = await send('/api/auth/sign-up/email', {
				dev_origin,
				cookie,
				body: JSON.stringify({ email, password, name })
			});
		}
		assert.equal(reply.status, 200, await reply.clone().text());
		return reply;
	};

	// The user an app server's direct get-session finds for the browser's Cookie header.
	const user_id = async (cookie: string) => {
		const reply = await send('/api/auth/get-session', { method: 'GET', cookie });
		assert.equal(reply.status, 200);
		const session = (await reply.json()) as { user: { id: string } } | null;
		return session?.user.id ?? null;
	};

	const sign_out = (dev_origin: string, cookie: string) =>
		send('/api/auth/sign-out', { dev_origin, cookie, body: '{}' });

	return { send, sign_in, user_id, sign_out };
}

// The `name=value` pair of a Set-Cookie header for `name`, as a browser would send it back.
function pair(reply: Response, name: string): string {
	const header = reply.headers.getSetCookie().find((cookie) => cookie.startsWith(`${name}=`));
	assert.ok(header, `No ${name} among ${JSON.stringify(reply.headers.getSetCookie())}`);
	return header.split(';')[0];
}

function cleared(reply: Response, name: string): string | undefined {
	return reply.headers
		.getSetCookie()
		.find((cookie) => cookie.startsWith(`${name}=;`) && /Max-Age=0/.test(cookie));
}

test('signing out at an https address ends the plain session that address reads', async () => {
	const auth = start_local_auth();
	const plain = pair(await auth.sign_in(HTTP_ORIGIN), SESSION_COOKIE);
	// The same browser, now on https, still sends the plain cookie, and app servers read it.
	assert.equal(await auth.user_id(plain), LOCAL_DEVELOPER.id);

	const reply = await auth.sign_out(HTTPS_ORIGIN, plain);
	assert.equal(reply.status, 200);
	assert.equal(
		cleared(reply, SESSION_COOKIE),
		'better-auth.session_token=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax'
	);
	assert.equal(cleared(reply, SECURE_SESSION_COOKIE), undefined);
	assert.equal(await auth.user_id(plain), null);
	assert.doesNotMatch(reply.headers.getSetCookie().join('\n'), /session_token=[^;]/);
});

test('signing out with both cookies ends both sessions, clearing each, and no other session', async () => {
	const auth = start_local_auth();
	const plain = pair(await auth.sign_in(HTTP_ORIGIN), SESSION_COOKIE);
	const secure = pair(await auth.sign_in(HTTPS_ORIGIN, plain), SECURE_SESSION_COOKIE);
	// Another address's browser session, which this browser never sends.
	const elsewhere = pair(await auth.sign_in('http://localhost:5173'), SESSION_COOKIE);
	const both = `${plain}; theme=dark; ${secure}`;
	assert.equal(await auth.user_id(both), LOCAL_DEVELOPER.id);

	for (const origin of [HTTPS_ORIGIN, HTTP_ORIGIN]) {
		const reply = await auth.sign_out(origin, both);
		assert.equal(reply.status, 200, origin);
		assert.deepEqual(await reply.json(), { success: true }, origin);
		// Each cookie in its own header, with its own name and attributes.
		assert.equal(
			cleared(reply, SESSION_COOKIE),
			'better-auth.session_token=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax',
			origin
		);
		assert.equal(
			cleared(reply, SECURE_SESSION_COOKIE),
			'__Secure-better-auth.session_token=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax',
			origin
		);
	}
	for (const cookie of [plain, secure, both]) assert.equal(await auth.user_id(cookie), null);
	assert.equal(await auth.user_id(elsewhere), LOCAL_DEVELOPER.id);
});

test('a plain sign-in expires a __Secure- cookie that would be read first, leaving its session alone', async () => {
	const auth = start_local_auth();
	const secure = pair(await auth.sign_in(HTTPS_ORIGIN), SECURE_SESSION_COOKIE);
	const stale = pair(await auth.sign_in(HTTPS_ORIGIN), SECURE_SESSION_COOKIE);
	assert.equal((await auth.sign_out(HTTPS_ORIGIN, stale)).status, 200);

	for (const [what, old] of [
		['a stale', stale],
		['a valid', secure]
	]) {
		// A browser on http://localhost sends __Secure- cookies too.
		const reply = await auth.sign_in('http://localhost:5173', `${old}; theme=dark`);
		const fresh = pair(reply, SESSION_COOKIE);
		// Better Auth's own words for clearing that cookie, as its sign-out writes them.
		const expected = expiring_set_cookie(SECURE_SESSION_COOKIE, {
			path: '/',
			httpOnly: true,
			secure: true,
			sameSite: 'lax'
		});
		assert.equal(cleared(reply, SECURE_SESSION_COOKIE), expected, what);
		assert.equal(
			expected,
			cleared(
				await auth.sign_out(HTTPS_ORIGIN, `${SECURE_SESSION_COOKIE}=x`),
				SECURE_SESSION_COOKIE
			)
		);
		// Kept, the old cookie would be read before the fresh one; expired, only the fresh one is.
		if (old === stale) assert.equal(await auth.user_id(`${fresh}; ${old}`), null);
		assert.equal(await auth.user_id(fresh), LOCAL_DEVELOPER.id, what);
	}
	// The valid session wasn't ended, only its cookie on this browser.
	assert.equal(await auth.user_id(secure), LOCAL_DEVELOPER.id);
});

test('an https sign-in issues only its __Secure- cookie, whatever plain cookie the browser has', async () => {
	const auth = start_local_auth();
	const plain = pair(await auth.sign_in(HTTP_ORIGIN), SESSION_COOKIE);
	const reply = await auth.sign_in(HTTPS_ORIGIN, plain);
	const names = reply.headers.getSetCookie().map((cookie) => cookie.split('=')[0]);
	assert.ok(names.includes(SECURE_SESSION_COOKIE));
	assert.ok(!names.includes(SESSION_COOKIE));
	assert.match(cleared(reply, SECURE_SESSION_COOKIE) ?? 'not cleared', /not cleared/);
	assert.equal(await auth.user_id(plain), LOCAL_DEVELOPER.id);
});

test('the cookie names in a request pick the sign-out passes, plain first', () => {
	assert.deepEqual(carried_profiles(null), []);
	assert.deepEqual(carried_profiles('theme=dark'), []);
	assert.deepEqual(carried_profiles(`${SECURE_SESSION_COOKIE}=a; ${SESSION_COOKIE}=b`), [
		false,
		true
	]);
	assert.deepEqual(carried_profiles(`x${SESSION_COOKIE}=a; ${SESSION_COOKIE}.x=b`), []);
	assert.deepEqual(carried_profiles(` ${SECURE_SESSION_COOKIE} =a`), [true]);
});

// A stand-in Better Auth that records each call and answers with `answers` in turn.
function stand_in(answers: Response[]) {
	const calls: { use_secure_cookies: boolean | undefined; body: string }[] = [];
	const handle = async (environment: AuthEnvironment, request: Request) => {
		calls.push({
			use_secure_cookies: environment.is_local_development
				? environment.use_secure_cookies
				: undefined,
			body: await request.text()
		});
		const answer = answers.shift();
		assert.ok(answer, 'Called more often than expected');
		return answer;
	};
	return { calls, handle };
}

function answer(status: number, set_cookies: string[]) {
	const headers = new Headers({ 'content-type': 'application/json' });
	for (const set_cookie of set_cookies) headers.append('set-cookie', set_cookie);
	return new Response(JSON.stringify({ token: 'never-read-here' }), { status, headers });
}

const SIGN_OUT = (cookie: string) =>
	new Request(`${LOCAL.BETTER_AUTH_URL}/api/auth/sign-out`, {
		method: 'POST',
		headers: { cookie, 'content-type': 'application/json' },
		body: '{"a":1}'
	});

test('a failing sign-out pass stops there with what was cleared, and nothing is repeated', async () => {
	const both = `${SESSION_COOKIE}=a; ${SECURE_SESSION_COOKIE}=b`;
	const failing = stand_in([answer(200, ['plain=cleared']), answer(500, ['secure=x'])]);
	const reply = await answer_local_auth(LOCAL, SIGN_OUT(both), failing.handle);
	assert.equal(reply.status, 500);
	assert.deepEqual(reply.headers.getSetCookie(), ['plain=cleared', 'secure=x']);
	assert.deepEqual(failing.calls, [
		{ use_secure_cookies: false, body: '{"a":1}' },
		{ use_secure_cookies: true, body: '{"a":1}' }
	]);

	const first_fails = stand_in([answer(403, [])]);
	assert.equal((await answer_local_auth(LOCAL, SIGN_OUT(both), first_fails.handle)).status, 403);
	assert.equal(first_fails.calls.length, 1);

	// With no session cookie, one pass in the origin's profile, as before.
	const none = stand_in([answer(200, [])]);
	await answer_local_auth({ ...LOCAL, use_secure_cookies: true }, SIGN_OUT('a=1'), none.handle);
	assert.deepEqual(none.calls, [{ use_secure_cookies: true, body: '{"a":1}' }]);
});

test('a sign-out canceled before it starts never calls Better Auth', async () => {
	const controller = new AbortController();
	controller.abort();
	const request = new Request(SIGN_OUT(`${SESSION_COOKIE}=a`), { signal: controller.signal });
	const passed = stand_in([answer(200, [])]);
	await assert.rejects(answer_local_auth(LOCAL, request, passed.handle), { name: 'AbortError' });
	assert.equal(passed.calls.length, 0);
});

test('canceling a sign-out propagates to the current profile and prevents another mutation', async () => {
	const controller = new AbortController();
	const both = `${SESSION_COOKIE}=a; ${SECURE_SESSION_COOKIE}=b`;
	const request = new Request(SIGN_OUT(both), { signal: controller.signal });
	const signals: AbortSignal[] = [];
	const handle = async (_environment: AuthEnvironment, pass: Request) => {
		signals.push(pass.signal);
		controller.abort();
		return answer(200, ['plain=cleared']);
	};
	await assert.rejects(answer_local_auth(LOCAL, request, handle), { name: 'AbortError' });
	assert.equal(signals.length, 1);
	assert.equal(signals[0].aborted, true);
});

test('deployed requests, and local ones other than sign-in and sign-out, go straight to Better Auth', async () => {
	const deployed: AuthEnvironment = {
		is_local_development: false,
		DB: {} as D1Database,
		BETTER_AUTH_URL: 'https://auth.syntax.fm',
		AUTH_COOKIE_DOMAIN: '.syntax.fm',
		BETTER_AUTH_SECRET: 'secret',
		GITHUB_CLIENT_ID: 'id',
		GITHUB_CLIENT_SECRET: 'secret'
	};
	const both = `${SESSION_COOKIE}=a; ${SECURE_SESSION_COOKIE}=b`;
	for (const [environment, request] of [
		[deployed, SIGN_OUT(both)],
		[
			LOCAL,
			new Request(`${LOCAL.BETTER_AUTH_URL}/api/auth/get-session`, { headers: { cookie: both } })
		],
		[
			LOCAL,
			new Request(`${LOCAL.BETTER_AUTH_URL}/api/auth/sign-out`, { headers: { cookie: both } })
		]
	] as const) {
		const original = answer(200, [`${SESSION_COOKIE}=refreshed`]);
		const passed = stand_in([original]);
		const reply = await answer_local_auth(environment, request, passed.handle);
		assert.equal(reply, original);
		assert.equal(passed.calls.length, 1);
	}

	// A failed or __Secure- sign-in is left as Better Auth answered it.
	for (const [environment, status] of [
		[LOCAL, 401],
		[{ ...LOCAL, use_secure_cookies: true }, 200]
	] as const) {
		const original = answer(status, []);
		const reply = await answer_local_auth(
			environment,
			new Request(`${LOCAL.BETTER_AUTH_URL}/api/auth/sign-in/email`, {
				method: 'POST',
				headers: { cookie: both },
				body: '{}'
			}),
			stand_in([original]).handle
		);
		assert.equal(reply, original);
	}
});
