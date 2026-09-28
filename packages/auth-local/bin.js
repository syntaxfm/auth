#!/usr/bin/env node
// For non-Vite dev scripts: `syntax-auth-local && next dev`.
import { ensure_syntax_auth } from './index.js';

await ensure_syntax_auth();
