// The one-click account of local Syntax Auth, as src/lib/server/local_developer.ts defines it there
// (src/lib/server/local_developer.test.ts checks the two match). Local mode alone accepts it:
// production Syntax Auth has no email and password sign-in.
export const LOCAL_DEVELOPER = Object.freeze({
	id: 'local-developer',
	name: 'Local Developer',
	email: 'developer@syntax.test',
	password: 'local-developer-password'
});
