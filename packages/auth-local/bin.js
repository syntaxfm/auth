#!/usr/bin/env node
// For non-Vite dev scripts: `syntax-auth-local && next dev` starts the shared local Syntax Auth.
// It changes nothing else on this computer. See CONSUMING_AUTH.md.
import { ensure_syntax_auth } from './index.js';

const USAGE = 'Usage: syntax-auth-local';

const args = process.argv.slice(2);

if (args.length === 0) {
	await ensure_syntax_auth();
} else if (args[0] === 'setup') {
	console.error(
		'`syntax-auth-local setup` was removed: Syntax apps no longer need hosts file, certificate, or HTTPS proxy setup. Sign in through the app at /__syntax_auth/sign-in (see CONSUMING_AUTH.md).'
	);
	process.exit(1);
} else {
	console.error(USAGE);
	process.exit(1);
}
