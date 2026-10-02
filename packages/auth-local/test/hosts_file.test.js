// The hosts file edit, with the real root script run on a temporary file in place of /etc/hosts.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, readFile, writeFile } from 'node:fs/promises';
import { test } from 'node:test';

import { run, with_port_lock } from '../container.js';
import { BLOCK_BEGIN, BLOCK_END, HOSTS_SCRIPT, ensure_hosts, plan_hosts } from '../hosts_file.js';
import { SYSTEM_HOSTS, create_mac, free_port } from './stand_ins.js';

const FULL_BLOCK = [
	BLOCK_BEGIN,
	'127.0.0.1 auth.syntax.test lab.syntax.test syntax.test',
	'::1 auth.syntax.test lab.syntax.test syntax.test',
	BLOCK_END
].join('\n');

/** @param {Awaited<ReturnType<typeof create_mac>>} mac @param {boolean} [can_ask] */
const ensure = (mac, can_ask = true) =>
	ensure_hosts({
		run: mac.run,
		hosts_path: mac.hosts_path,
		can_ask,
		setup_command: 'pnpm exec syntax-auth-local setup lab',
		flush: false
	});

/** @param {string} path */
const sha256_of = async (path) =>
	createHash('sha256')
		.update(await readFile(path))
		.digest('hex');

/**
 * The root script as the AppleScript runs it, against the file as it is now unless `sha256` says
 * otherwise.
 * @param {string} path
 * @param {string} block
 * @param {{ sha256?: string, flush?: string }} [options]
 */
const run_script = async (path, block, { sha256, flush = 'no-flush' } = {}) =>
	run('/bin/sh', [
		'-c',
		HOSTS_SCRIPT,
		'syntax-test-hosts',
		path,
		block,
		flush,
		sha256 ?? (await sha256_of(path))
	]);

test('adds every missing name once, and a second start asks nothing', async () => {
	const mac = await create_mac({ caddy: false });
	try {
		assert.deepEqual(await ensure(mac), { changed: true, elsewhere: [] });
		assert.equal(await mac.read_hosts(), `${SYSTEM_HOSTS}${FULL_BLOCK}\n`);
		assert.equal(await readFile(`${mac.hosts_path}.syntax-test.bak`, 'utf8'), SYSTEM_HOSTS);

		assert.deepEqual(await ensure(mac), { changed: false, elsewhere: [] });
		assert.deepEqual(mac.commands(), ['osascript -e']);
	} finally {
		await mac.close();
	}
});

test('keeps every other line, leaves a name pointing elsewhere alone, and skips names already present', async () => {
	const original = `${SYSTEM_HOSTS}\t10.0.0.5   syntax.test   # the website on the NAS\n::1 auth.syntax.test\n127.0.0.1 auth.syntax.test\n# end of my lines`;
	const mac = await create_mac({ caddy: false, hosts: original });
	try {
		assert.deepEqual(await ensure(mac), {
			changed: true,
			elsewhere: [{ hostname: 'syntax.test', address: '10.0.0.5' }]
		});
		const block = `${BLOCK_BEGIN}\n127.0.0.1 lab.syntax.test\n::1 lab.syntax.test\n${BLOCK_END}`;
		assert.equal(await mac.read_hosts(), `${original}\n${block}\n`);

		// A later change replaces only the block, in place, keeping the lines after it.
		await writeFile(mac.hosts_path, `${await mac.read_hosts()}192.168.1.9 printer.home\n`);
		await writeFile(mac.hosts_path, (await mac.read_hosts()).replace('::1 lab.syntax.test\n', ''));
		assert.deepEqual(await ensure(mac), {
			changed: true,
			elsewhere: [{ hostname: 'syntax.test', address: '10.0.0.5' }]
		});
		assert.equal(await mac.read_hosts(), `${original}\n${block}\n192.168.1.9 printer.home\n`);
	} finally {
		await mac.close();
	}
});

test('a damaged block is refused by the plan and by the root script, and nothing changes', async () => {
	const damaged = `${SYSTEM_HOSTS}${BLOCK_BEGIN}\n127.0.0.1 lab.syntax.test\n`;
	const mac = await create_mac({ caddy: false, hosts: damaged });
	try {
		assert.deepEqual(await ensure(mac), {
			problem: `The syntax.test block in ${mac.hosts_path} is damaged: it needs exactly one "${BLOCK_BEGIN}" line followed by one "${BLOCK_END}" line, and it has 1 start line and 0 end lines.`,
			fix: `Fix or delete those lines with \`sudo nano ${mac.hosts_path}\`, then restart dev.`
		});
		assert.deepEqual(mac.commands(), []);

		const result = await run_script(mac.hosts_path, '127.0.0.1 lab.syntax.test');
		assert.equal(result.code, 3);
		assert.match(result.stderr, /is damaged/);
		assert.equal(await mac.read_hosts(), damaged);
	} finally {
		await mac.close();
	}
});

test('a declined password, or a dialog nobody answers, changes nothing', async () => {
	const mac = await create_mac({ caddy: false });
	try {
		mac.state.hosts_answer = 'cancel';
		assert.deepEqual(await ensure(mac), {
			problem: `You canceled the password dialog, so ${mac.hosts_path} wasn't changed.`,
			fix: 'Restart dev and enter your password (or use Touch ID) to add the .syntax.test names.'
		});
		mac.state.hosts_answer = 'timeout';
		assert.deepEqual(await ensure(mac), {
			problem: `The password dialog for ${mac.hosts_path} was open for 5 minutes without an answer, so setup closed it and changed nothing.`,
			fix: 'Restart dev and answer the dialog.'
		});
		assert.equal(await mac.read_hosts(), SYSTEM_HOSTS);
		await assert.rejects(access(`${mac.hosts_path}.syntax-test.bak`));
	} finally {
		await mac.close();
	}
});

test('without a person at the screen, nothing changes and the printed command adds exactly the block', async () => {
	const mac = await create_mac({ caddy: false });
	try {
		const result = await ensure(mac, false);
		assert.ok('problem' in result);
		assert.equal(
			result.problem,
			`${mac.hosts_path} doesn't point the .syntax.test names at this computer, and changing it needs your password in a dialog on this computer's screen, which nobody can answer from here.`
		);
		assert.deepEqual(mac.commands(), []);
		assert.equal(await mac.read_hosts(), SYSTEM_HOSTS);

		// Run the printed fix, without sudo, against the temporary file.
		const command = result.fix.match(/`(printf .*)`$/)?.[1];
		assert.ok(command, result.fix);
		const ran = await run('/bin/sh', ['-c', command.replace('sudo tee', 'tee')]);
		assert.equal(ran.code, 0, ran.stderr);
		assert.equal(await mac.read_hosts(), `${SYSTEM_HOSTS}${FULL_BLOCK}\n`);
		assert.deepEqual(await ensure(mac, false), { changed: false, elsewhere: [] });
	} finally {
		await mac.close();
	}
});

test('an edit interrupted at any moment leaves the old file or the new one, and the next start finishes it', async () => {
	const mac = await create_mac({ caddy: false });
	try {
		// A long file, so interruptions land at every stage of the script.
		const original = `${SYSTEM_HOSTS}${'10.9.9.9 filler.home\n'.repeat(20_000)}`;
		await writeFile(mac.hosts_path, original);
		const plan = plan_hosts(original);
		assert.ok('block' in plan);
		const finished = `${original}${FULL_BLOCK}\n`;

		// Interruptions spread over one whole uninterrupted run.
		const started = Date.now();
		await run_script(mac.hosts_path, plan.block);
		const duration_ms = Date.now() - started;
		const seen = new Set();
		const sha256 = createHash('sha256').update(original).digest('hex');
		for (let attempt = 0; attempt < 30; attempt++) {
			await writeFile(mac.hosts_path, original);
			const child = spawn('/bin/sh', [
				'-c',
				HOSTS_SCRIPT,
				'syntax-test-hosts',
				mac.hosts_path,
				plan.block,
				'no-flush',
				sha256
			]);
			const closed = new Promise((resolve) => child.once('close', resolve));
			await new Promise((resolve) => setTimeout(resolve, (attempt / 25) * duration_ms));
			child.kill('SIGKILL');
			await closed;
			const text = await mac.read_hosts();
			assert.ok(text === original || text === finished, `attempt ${attempt} left a partial file`);
			seen.add(text === original ? 'old' : 'new');
		}
		assert.deepEqual([...seen].sort(), ['new', 'old']);

		await writeFile(mac.hosts_path, original);
		assert.deepEqual(await ensure(mac), { changed: true, elsewhere: [] });
		assert.equal(await mac.read_hosts(), finished);
		await assert.rejects(access(`${mac.hosts_path}.syntax-test.tmp`));
	} finally {
		await mac.close();
	}
});

test('two dev servers starting at once leave one valid block, and only one asks', async () => {
	const mac = await create_mac({ caddy: false });
	try {
		const lock_port = await free_port();
		const results = await Promise.all([
			with_port_lock(lock_port, () => ensure(mac)),
			with_port_lock(lock_port, () => ensure(mac))
		]);
		assert.deepEqual(results.map((result) => 'changed' in result && result.changed).sort(), [
			false,
			true
		]);
		assert.equal(await mac.read_hosts(), `${SYSTEM_HOSTS}${FULL_BLOCK}\n`);
		assert.equal(mac.commands().filter((command) => command === 'osascript -e').length, 1);
	} finally {
		await mac.close();
	}
});

test('an entry another program adds while the dialog is open stops the edit, and the next start leaves it alone', async () => {
	const mac = await create_mac({ caddy: false });
	try {
		const added = `${SYSTEM_HOSTS}10.1.2.3 lab.syntax.test\n`;
		mac.state.while_dialog_open = () => writeFile(mac.hosts_path, added);
		assert.deepEqual(await ensure(mac), {
			problem: `${mac.hosts_path} changed while the password dialog was open (another program edited it), so setup left it as it is.`,
			fix: 'Restart dev to try again: setup plans from the file as it is then.'
		});
		assert.equal(await mac.read_hosts(), added);
		await assert.rejects(access(`${mac.hosts_path}.syntax-test.bak`));

		mac.state.while_dialog_open = async () => {};
		assert.deepEqual(await ensure(mac), {
			changed: true,
			elsewhere: [{ hostname: 'lab.syntax.test', address: '10.1.2.3' }]
		});
		assert.equal(
			await mac.read_hosts(),
			`${added}${BLOCK_BEGIN}\n127.0.0.1 auth.syntax.test syntax.test\n::1 auth.syntax.test syntax.test\n${BLOCK_END}\n`
		);
	} finally {
		await mac.close();
	}
});

test('the root script checks its arguments and changes nothing on a bad one', async () => {
	const mac = await create_mac({ caddy: false });
	try {
		for (const [
			block,
			options,
			message
		] of /** @type {[string, { sha256?: string, flush?: string }, RegExp][]} */ ([
			['10.0.0.1 lab.syntax.test', {}, /aren't \.syntax\.test entries/],
			['127.0.0.1 evil.example', {}, /aren't \.syntax\.test entries/],
			["127.0.0.1 lab.syntax.test\n127.0.0.1 x'; rm -rf /", {}, /aren't \.syntax\.test entries/],
			['127.0.0.1 lab.syntax.test', { sha256: 'abc' }, /malformed checksum/],
			['127.0.0.1 lab.syntax.test', { sha256: `${'A'.repeat(64)}` }, /malformed checksum/],
			['127.0.0.1 lab.syntax.test', { flush: 'sometimes' }, /unknown flush argument/]
		])) {
			const result = await run_script(mac.hosts_path, block, options);
			assert.equal(result.code, 2, block);
			assert.match(result.stderr, message);
			assert.equal(await mac.read_hosts(), SYSTEM_HOSTS);
		}
		const stale = await run_script(mac.hosts_path, '127.0.0.1 lab.syntax.test', {
			sha256: '0'.repeat(64)
		});
		assert.equal(stale.code, 4);
		assert.equal(
			stale.stderr,
			`${mac.hosts_path} changed while the password dialog was open, so setup left it as it is.`
		);
		assert.equal(await mac.read_hosts(), SYSTEM_HOSTS);
	} finally {
		await mac.close();
	}
});

test('CRLF lines, damaged or repeated blocks, and a missing final newline are read alike by the plan and the root script', async () => {
	const block_lines =
		'127.0.0.1 auth.syntax.test lab.syntax.test syntax.test\n::1 auth.syntax.test lab.syntax.test syntax.test';
	const damaged = {
		'a CRLF start line without an end line': `${SYSTEM_HOSTS}${BLOCK_BEGIN}\r\n127.0.0.1 lab.syntax.test\r\n`,
		'two blocks': `${SYSTEM_HOSTS}${FULL_BLOCK}\n${FULL_BLOCK}\n`,
		'an end line before the start line': `${SYSTEM_HOSTS}${BLOCK_END}\n${BLOCK_BEGIN}\n`,
		'an altered start line': `${SYSTEM_HOSTS}${BLOCK_BEGIN} \n${block_lines}\n${BLOCK_END}\n`,
		'an altered marker alone': `${SYSTEM_HOSTS}# >>> syntax.test: added by hand\n127.0.0.1 lab.syntax.test\n`,
		'a lone end line': `${SYSTEM_HOSTS}${BLOCK_END}\r\n`
	};
	for (const [scene, text] of Object.entries(damaged)) {
		const mac = await create_mac({ caddy: false, hosts: text });
		try {
			const result = await ensure(mac);
			assert.ok('problem' in result, scene);
			assert.match(result.problem, /is damaged: it needs exactly one/, scene);
			assert.deepEqual(mac.commands(), [], scene);
			const ran = await run_script(mac.hosts_path, '127.0.0.1 lab.syntax.test');
			assert.equal(ran.code, 3, scene);
			assert.equal(await mac.read_hosts(), text, scene);
		} finally {
			await mac.close();
		}
	}

	// A whole CRLF block is current: nothing to ask.
	const crlf = `${SYSTEM_HOSTS.replaceAll('\n', '\r\n')}${FULL_BLOCK.replaceAll('\n', '\r\n')}\r\n`;
	const current = await create_mac({ caddy: false, hosts: crlf });
	try {
		assert.deepEqual(await ensure(current), { changed: false, elsewhere: [] });
		assert.deepEqual(current.commands(), []);
	} finally {
		await current.close();
	}

	// Rewriting keeps every byte outside the block: CRLF endings and a missing final newline.
	const before = `127.0.0.1\tlocalhost\r\n${BLOCK_BEGIN}\r\n::1 lab.syntax.test\r\n${BLOCK_END}\r\n10.1.2.4 nas.home\r\n# no final newline`;
	const rewrite = await create_mac({ caddy: false, hosts: before });
	try {
		assert.deepEqual(await ensure(rewrite), { changed: true, elsewhere: [] });
		assert.equal(
			await rewrite.read_hosts(),
			`127.0.0.1\tlocalhost\r\n${FULL_BLOCK}\n10.1.2.4 nas.home\r\n# no final newline`
		);
	} finally {
		await rewrite.close();
	}

	// Appending to a file without a final newline starts the block on its own line.
	const unterminated = `${SYSTEM_HOSTS}# last line`;
	const append = await create_mac({ caddy: false, hosts: unterminated });
	try {
		assert.deepEqual(await ensure(append), { changed: true, elsewhere: [] });
		assert.equal(await append.read_hosts(), `${unterminated}\n${FULL_BLOCK}\n`);
	} finally {
		await append.close();
	}
});

test('without a person at the screen, the printed command also works on a file without a final newline', async () => {
	const unterminated = `${SYSTEM_HOSTS}# last line`;
	const mac = await create_mac({ caddy: false, hosts: unterminated });
	try {
		const result = await ensure(mac, false);
		assert.ok('problem' in result);
		const command = result.fix.match(/`(printf .*)`$/)?.[1];
		assert.ok(command, result.fix);
		const ran = await run('/bin/sh', ['-c', command.replace('sudo tee', 'tee')]);
		assert.equal(ran.code, 0, ran.stderr);
		assert.equal(await mac.read_hosts(), `${unterminated}\n${FULL_BLOCK}\n`);
		assert.deepEqual(await ensure(mac, false), { changed: false, elsewhere: [] });
	} finally {
		await mac.close();
	}
});
