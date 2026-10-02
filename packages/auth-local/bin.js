#!/usr/bin/env node
// For non-Vite dev scripts: `syntax-auth-local && next dev`.
// `syntax-auth-local setup [auth|lab|website]` sets up the https://*.syntax.test names from a
// terminal, for example when dev runs where nobody can answer a dialog. See README.md.
import { log, warn } from './container.js';
import { ensure_syntax_auth } from './index.js';
import { SITE_LABELS, is_site_name, site_url } from './names.js';
import { default_setup_deps, describe_result, run_setup } from './setup.js';

const [command, name = 'auth', ...extra] = process.argv.slice(2);

if (command === undefined) {
	await ensure_syntax_auth();
} else if (command === 'setup' && is_site_name(name) && extra.length === 0) {
	const result = await run_setup({ name }, default_setup_deps());
	if (result.state === 'worked') {
		log(
			name === 'auth'
				? `${site_url('auth')} is ready.`
				: `Setup is done: ${site_url(name)} will reach ${SITE_LABELS[name]}'s dev server once it starts.`
		);
	} else {
		const [first, ...rest] = describe_result({ name }, result, undefined);
		(result.state === 'failed' ? warn : log)(
			[first, ...rest.map((line) => `  ${line}`)].join('\n')
		);
	}
	process.exit(result.state === 'failed' ? 1 : 0);
} else {
	console.error('Usage: syntax-auth-local [setup [auth|lab|website]]');
	process.exit(1);
}
