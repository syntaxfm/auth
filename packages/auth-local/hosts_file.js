// Points the .syntax.test names at this computer in /etc/hosts, inside one marked block. Node only
// plans and checks; the edit itself is a constant shell script run as root through macOS's password
// dialog, so no file a user could change ever runs as root.
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { first_line } from './container.js';
import { LOOPBACK_ADDRESSES, SYNTAX_TEST_HOSTNAMES } from './names.js';

export const HOSTS_PATH = '/etc/hosts';
export const BLOCK_BEGIN = '# >>> syntax.test: added by Syntax dev setup (@syntaxfm/auth-local)';
export const BLOCK_END = '# <<< syntax.test';
const DIALOG_TIMEOUT_MS = 300_000;
const PROMPT =
	'Syntax dev setup wants to point auth.syntax.test, lab.syntax.test, and syntax.test at this Mac in /etc/hosts.';

// Run as root with: the hosts file's path, the block's lines, `flush` or `no-flush` (macOS's DNS
// cache), and the SHA-256 of the file setup planned from. The script is constant: everything it
// gets is an argument, which it checks before use. It refuses the edit when the live file isn't the
// one setup planned from (another program changed it while the dialog was open), and when the block
// is damaged. It keeps a backup, replaces only the marked block (or appends one), keeps every other
// byte as it was (line endings, and a missing final newline), and moves a finished copy into place,
// so an interruption at any moment leaves either the old file or the new one.
// Exit 2: a bad argument; 3: the block is damaged; 4: the file changed since planning.
export const HOSTS_SCRIPT = String.raw`set -eu
hosts=$1
block=$2
flush=$3
expected=$4
begin='${BLOCK_BEGIN}'
end='${BLOCK_END}'
tmp="$hosts.syntax-test.tmp"
case $flush in
	flush | no-flush) ;;
	*) echo "Setup passed an unknown flush argument." >&2; exit 2 ;;
esac
if ! awk -v hash="$expected" 'BEGIN { exit !(length(hash) == 64 && hash !~ /[^0-9a-f]/) }'; then
	echo "Setup passed a malformed checksum for $hosts." >&2
	exit 2
fi
if [ -n "$block" ] && ! printf '%s\n' "$block" | awk '
	!/^(127\.0\.0\.1|::1)( (auth\.syntax\.test|lab\.syntax\.test|syntax\.test))+$/ { bad = 1 }
	END { exit bad ? 1 : 0 }
'; then
	echo "Setup passed lines that aren't .syntax.test entries for 127.0.0.1 or ::1." >&2
	exit 2
fi
trap 'rm -f "$tmp"' EXIT
trap 'exit 1' HUP INT TERM
actual=$(shasum -a 256 < "$hosts")
actual=$(printf '%s' "$actual" | awk '{ print $1 }')
if [ "$actual" != "$expected" ]; then
	echo "$hosts changed while the password dialog was open, so setup left it as it is." >&2
	exit 4
fi
if ! awk -v begin="$begin" -v end="$end" '
	{ line = $0; sub(/\r$/, "", line) }
	line == begin { if (state != 0) bad = 1; state = 1; next }
	line == end { if (state != 1) bad = 1; state = 2; next }
	line ~ /^[ \t]*#[ \t]*(>>>|<<<)[ \t]*syntax\.test/ { bad = 1 }
	END { exit (bad || state == 1) ? 1 : 0 }
' "$hosts"; then
	echo "The syntax.test block in $hosts is damaged: it needs exactly one '$begin' line followed by one '$end' line." >&2
	exit 3
fi
final_newline=1
if [ -n "$(tail -c 1 "$hosts")" ]; then final_newline=0; fi
cp -p "$hosts" "$hosts.syntax-test.bak"
cp -p "$hosts" "$tmp"
SYNTAX_TEST_BLOCK=$block awk -v begin="$begin" -v end="$end" -v final_newline="$final_newline" '
	function flush_pending() { if (has_pending) { printf "%s\n", pending; has_pending = 0 } }
	function print_block() { printf "%s\n%s\n%s\n", begin, ENVIRON["SYNTAX_TEST_BLOCK"], end }
	{ line = $0; sub(/\r$/, "", line) }
	line == begin {
		flush_pending()
		found = 1
		inside = 1
		if (ENVIRON["SYNTAX_TEST_BLOCK"] != "") print_block()
		next
	}
	inside { if (line == end) inside = 0; next }
	{ flush_pending(); pending = $0; has_pending = 1 }
	END {
		if (!found && ENVIRON["SYNTAX_TEST_BLOCK"] != "") { flush_pending(); print_block() }
		if (has_pending) printf "%s%s", pending, (final_newline ? "\n" : "")
	}
' "$hosts" > "$tmp"
mv -f "$tmp" "$hosts"
if [ "$flush" = flush ]; then
	dscacheutil -flushcache
	killall -HUP mDNSResponder || true
fi
`;

// Passes the script and its arguments to `do shell script` quoted, never interpolated.
export const APPLESCRIPT = [
	'on run argv',
	'set command to "/bin/sh -c " & quoted form of item 1 of argv & " syntax-test-hosts " & quoted form of item 2 of argv & " " & quoted form of item 3 of argv & " " & quoted form of item 4 of argv & " " & quoted form of item 5 of argv',
	'do shell script command with prompt (item 6 of argv) with administrator privileges',
	'end run'
];

/**
 * @typedef {{ hostname: string, address: string }} ElsewhereEntry
 * @typedef {{ problem: string, fix: string }} Problem
 * @typedef {Problem | { block: string, has_block: boolean, is_current: boolean, ends_with_newline: boolean, elsewhere: ElsewhereEntry[] }} HostsPlan
 */

// A line that looks like one of the block's markers but isn't exactly one.
const MARKER_LIKE = /^[ \t]*#[ \t]*(>>>|<<<)[ \t]*syntax\.test/;

/** @param {string} line */
function parse_entry(line) {
	const [address, ...names] = line.replace(/#.*/, '').trim().split(/\s+/);
	return { address: address ?? '', names: names.map((name) => name.toLowerCase()) };
}

/**
 * Plans the marked block from the file's text: each name gets 127.0.0.1 and ::1 entries unless the
 * lines outside the block already have them. A name another line points elsewhere is left alone.
 * Lines may end in LF or CRLF; the root script reads them the same way.
 * @param {string} text
 * @param {string} hosts_path
 * @returns {HostsPlan}
 */
export function plan_hosts(text, hosts_path = HOSTS_PATH) {
	const lines = text.split('\n').map((line) => line.replace(/\r$/, ''));
	const begins = lines.flatMap((line, i) => (line === BLOCK_BEGIN ? [i] : []));
	const ends = lines.flatMap((line, i) => (line === BLOCK_END ? [i] : []));
	const altered = lines.filter(
		(line) => line !== BLOCK_BEGIN && line !== BLOCK_END && MARKER_LIKE.test(line)
	);
	if (begins.length > 1 || begins.length !== ends.length || ends[0] < begins[0] || altered.length) {
		const found = [
			`${begins.length} start ${begins.length === 1 ? 'line' : 'lines'}`,
			`${ends.length} end ${ends.length === 1 ? 'line' : 'lines'}`,
			...(altered.length
				? [`${altered.length} altered marker ${altered.length === 1 ? 'line' : 'lines'}`]
				: [])
		];
		return {
			problem: `The syntax.test block in ${hosts_path} is damaged: it needs exactly one "${BLOCK_BEGIN}" line followed by one "${BLOCK_END}" line, and it has ${new Intl.ListFormat('en').format(found)}.`,
			fix: `Fix or delete those lines with \`sudo nano ${hosts_path}\`, then restart dev.`
		};
	}

	const [begin_index] = begins;
	const [end_index] = ends;
	const inside = (/** @type {number} */ index) =>
		begins.length === 1 && index >= begin_index && index <= end_index;
	const outside_entries = lines.filter((_, index) => !inside(index)).map(parse_entry);
	const current_block = lines
		.filter((_, index) => inside(index) && index !== begin_index && index !== end_index)
		.join('\n');

	/** @type {ElsewhereEntry[]} */
	const elsewhere = [];
	/** @type {Map<string, string[]>} */
	const needed = new Map(LOOPBACK_ADDRESSES.map((address) => [address, []]));
	for (const hostname of SYNTAX_TEST_HOSTNAMES) {
		const addresses = outside_entries
			.filter((entry) => entry.names.includes(hostname))
			.map((entry) => entry.address);
		const other = addresses.find((address) => !LOOPBACK_ADDRESSES.includes(address));
		if (other) {
			elsewhere.push({ hostname, address: other });
			continue;
		}
		for (const address of LOOPBACK_ADDRESSES) {
			if (!addresses.includes(address)) needed.get(address)?.push(hostname);
		}
	}

	const block = [...needed]
		.filter(([, hostnames]) => hostnames.length > 0)
		.map(([address, hostnames]) => `${address} ${hostnames.join(' ')}`)
		.join('\n');
	return {
		block,
		has_block: begins.length === 1,
		is_current: block === current_block,
		ends_with_newline: text === '' || text.endsWith('\n'),
		elsewhere
	};
}

/** @param {ElsewhereEntry} entry @param {string} hosts_path @returns {Problem} */
export function describe_elsewhere(entry, hosts_path = HOSTS_PATH) {
	return {
		problem: `${hosts_path} points ${entry.hostname} at ${entry.address}, so setup left that line alone, and https://${entry.hostname} reaches ${entry.address}, not this computer.`,
		fix: `To use it here, delete that line with \`sudo nano ${hosts_path}\`, then restart dev.`
	};
}

/**
 * @typedef {object} HostsOptions
 * @property {import('./container.js').Run} run
 * @property {string} hosts_path
 * @property {boolean} can_ask whether a person at this computer's desktop can answer a dialog
 * @property {string} setup_command the command that runs setup in a terminal
 * @property {boolean} [flush] whether to flush macOS's DNS cache after the edit
 * @property {number} [timeout_ms] how long the password dialog may stay open
 */

/**
 * Makes sure the hosts file has the marked block, asking for the administrator password only when
 * it must change.
 * @param {HostsOptions} options
 * @returns {Promise<Problem | { changed: boolean, elsewhere: ElsewhereEntry[] }>}
 */
export async function ensure_hosts({
	run,
	hosts_path,
	can_ask,
	setup_command,
	flush = true,
	timeout_ms = DIALOG_TIMEOUT_MS
}) {
	/** @returns {Promise<HostsPlan & { sha256?: string }>} */
	const read_plan = async () => {
		try {
			const bytes = await readFile(hosts_path);
			const plan = plan_hosts(bytes.toString('utf8'), hosts_path);
			if ('problem' in plan) return plan;
			return { ...plan, sha256: createHash('sha256').update(bytes).digest('hex') };
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return {
				problem: `${hosts_path} couldn't be read (${message}).`,
				fix: `Make sure ${hosts_path} exists and is readable (\`ls -l ${hosts_path}\`), then restart dev.`
			};
		}
	};

	const plan = await read_plan();
	if ('problem' in plan) return plan;
	if (plan.is_current) return { changed: false, elsewhere: plan.elsewhere };

	if (!can_ask) {
		const lines = [BLOCK_BEGIN, ...plan.block.split('\n'), BLOCK_END];
		// A file without a final newline first gets one, so the block starts on its own line.
		const appended = plan.ends_with_newline ? lines : ['', ...lines];
		return {
			problem: `${hosts_path} doesn't point the .syntax.test names at this computer, and changing it needs your password in a dialog on this computer's screen, which nobody can answer from here.`,
			fix: plan.has_block
				? `Run \`${setup_command}\` in Terminal at this computer's own screen (or over Screen Sharing), or replace the syntax.test block in ${hosts_path} (\`sudo nano ${hosts_path}\`) with these lines: ${lines.join(' | ')}`
				: `Run \`${setup_command}\` in Terminal at this computer's own screen (or over Screen Sharing), or add the lines yourself: \`printf '%s\\n' ${appended.map((line) => `'${line}'`).join(' ')} | sudo tee -a ${hosts_path}\``
		};
	}

	const result = await run(
		'osascript',
		[
			...APPLESCRIPT.flatMap((line) => ['-e', line]),
			HOSTS_SCRIPT,
			hosts_path,
			plan.block,
			flush ? 'flush' : 'no-flush',
			String(plan.sha256),
			PROMPT
		],
		{ timeout_ms }
	);
	if (result.timed_out) {
		return {
			problem: `The password dialog for ${hosts_path} was open for 5 minutes without an answer, so setup closed it and changed nothing.`,
			fix: 'Restart dev and answer the dialog.'
		};
	}
	if (/\(-128\)/.test(result.stderr)) {
		return {
			problem: `You canceled the password dialog, so ${hosts_path} wasn't changed.`,
			fix: 'Restart dev and enter your password (or use Touch ID) to add the .syntax.test names.'
		};
	}
	if (result.code !== 0) {
		const error = first_line(result.stderr)
			.replace(/^\d+:\d+: execution error: /, '')
			.replace(/ \(-?\d+\)$/, '')
			.trim();
		const reason = error
			? error.replace(/\.?$/, '.')
			: `osascript exited with code ${result.code}.`;
		if (/changed while the password dialog was open/.test(reason)) {
			return {
				problem: `${hosts_path} changed while the password dialog was open (another program edited it), so setup left it as it is.`,
				fix: 'Restart dev to try again: setup plans from the file as it is then.'
			};
		}
		return {
			problem: /damaged/.test(reason) ? reason : `${hosts_path} couldn't be changed: ${reason}`,
			fix: /damaged/.test(reason)
				? `Fix or delete those lines with \`sudo nano ${hosts_path}\`, then restart dev.`
				: 'Restart dev to try again.'
		};
	}

	const after = await read_plan();
	if ('problem' in after) return after;
	if (!after.is_current) {
		return {
			problem: `The edit finished, but ${hosts_path} still lacks the .syntax.test lines it needs.`,
			fix: 'Restart dev to try again.'
		};
	}
	return { changed: true, elsewhere: after.elsewhere };
}
