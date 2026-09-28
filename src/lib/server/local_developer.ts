// The one-click account available only while Syntax Auth runs locally. Its ID is fixed so consumer
// apps can map it to local roles in their seed data; see CONSUMING_AUTH.md.
export const LOCAL_DEVELOPER = {
	id: 'local-developer',
	name: 'Local Developer',
	email: 'developer@syntax.test',
	password: 'local-developer-password'
} as const;
