'use strict';

// ============================================================================
// 31TRADES — Environment loader (zero dependencies)
// ----------------------------------------------------------------------------
// Reads KEY=VALUE pairs from the project-root .env file into process.env.
// Real environment variables always win (they are never overridden), and
// empty values are ignored so a placeholder .env is harmless.
// ============================================================================

const fs = require('node:fs');
const path = require('node:path');

function loadEnv(file) {
    const p = file || path.join(__dirname, '..', '.env');
    if (!fs.existsSync(p)) return 0;

    let loaded = 0;
    fs.readFileSync(p, 'utf8')
        .split(/\r?\n/)
        .forEach(line => {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith('#')) return;
            const eq = trimmed.indexOf('=');
            if (eq <= 0) return;
            const key = trimmed.slice(0, eq).trim();
            let val = trimmed.slice(eq + 1).trim();
            if (!val) return;                                   // placeholder — ignore
            if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
                val = val.slice(1, -1);
            }
            if (process.env[key] === undefined) {
                process.env[key] = val;
                loaded++;
            }
        });
    return loaded;
}

module.exports = { loadEnv };
