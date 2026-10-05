// Whether a person is likely at this Mac's screen, so starting local Syntax Auth may open Docker
// Desktop or OrbStack, whose first run and privileged helper can show dialogs of their own.
import { is_set } from './container.js';

/** Set to `allow` to let an agent shell open the Docker app while a person watches the screen. */
export const DIALOGS_SWITCH = 'SYNTAX_DEV_SETUP_DIALOGS';

/** The variables that mark a shell an AI coding agent started. */
const AGENT_VARIABLES = ['CLAUDECODE', 'PI_CODING_AGENT'];

/** Each variable that marks a run nobody at the screen can answer, and where that run started. */
const AWAY_VARIABLES = [
	['NODE_TEST_CONTEXT', 'under a test runner (NODE_TEST_CONTEXT is set)'],
	['VITEST', 'under a test runner (VITEST is set)'],
	['CI', 'in CI (CI is set)'],
	['SSH_CONNECTION', 'over SSH (SSH_CONNECTION is set)'],
	['SSH_TTY', 'over SSH (SSH_TTY is set)']
];

/**
 * Null when the Docker app may be opened: a person is likely at this Mac's own desktop session.
 * Otherwise where this run started, like "from an agent shell (PI_CODING_AGENT)". Under a test
 * runner, over SSH, in CI, or outside the desktop session nobody can answer a dialog; from an agent
 * shell nobody is known to be watching, unless `SYNTAX_DEV_SETUP_DIALOGS=allow` says a person is.
 * That switch never works under a test runner, over SSH, or in CI. Every marker counts when it is
 * set at all, whatever its value (even "", "0", or "false"); only the switch needs exactly `allow`.
 * @param {{ run: import('./container.js').Run, env: NodeJS.ProcessEnv }} deps
 * @returns {Promise<string | null>}
 */
export async function why_not_open({ run, env }) {
	const marked = AWAY_VARIABLES.find(([variable]) => is_set(env, variable));
	if (marked) return marked[1];
	const manager = await run('launchctl', ['managername']);
	const session = manager.code === 0 ? manager.stdout.trim() : '';
	if (session !== 'Aqua') {
		return `outside this Mac's desktop session (\`launchctl managername\` says ${session || 'nothing'}, not Aqua)`;
	}
	const agent = AGENT_VARIABLES.find((variable) => is_set(env, variable));
	if (agent && env[DIALOGS_SWITCH] !== 'allow') return `from an agent shell (${agent})`;
	return null;
}
