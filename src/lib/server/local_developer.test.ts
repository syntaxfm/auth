// The development proxy in packages/auth-local signs in with its own copy of the account, since the
// package installs into other apps without this repository's source.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { LOCAL_DEVELOPER as PACKAGE_LOCAL_DEVELOPER } from '../../../packages/auth-local/local_developer.js';
import { LOCAL_DEVELOPER } from './local_developer';

test("the package's Local Developer is this one", () => {
	assert.deepEqual({ ...PACKAGE_LOCAL_DEVELOPER }, { ...LOCAL_DEVELOPER });
});
