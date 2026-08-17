'use strict';

// ============================================================================
// 31TRADES — Migration runner
// ----------------------------------------------------------------------------
// Applies db/migrations/*.sql in filename order to the Supabase Postgres
// configured via SUPABASE_DB_URL. Tracks applied files in schema_migrations,
// so re-running is a no-op. Each migration runs in its own transaction.
//
// Usage:  npm run db:migrate            (strict — fails loudly when the DB is
//                                        unreachable; for manual/CI runs)
//         node db/migrate.js --deploy   (best-effort — runs as part of `npm
//                                        start` on every deploy, so the Railway
//                                        container applies pending migrations
//                                        with its own real credentials; if the
//                                        DB is unreachable it logs and exits 0
//                                        so the app still boots in file mode)
// ============================================================================

const fs = require('node:fs');
const path = require('node:path');
const { Pool } = require('pg');
const { loadEnv } = require('../server/env.js');

loadEnv();

// --deploy = best-effort deploy-time mode (never fail the boot)
const DEPLOY_MODE = process.argv.includes('--deploy');
function exit0(msg) {
    if (msg) console.log(msg);
    process.exit(0);
}
function dbGone(err) {
    if (DEPLOY_MODE) {
        console.log('[migrate] database unreachable (' + err.message + ') — skipping migrations, app continues in file-fallback mode');
        return exit0();
    }
    console.error('Cannot reach the database: ' + err.message);
    process.exit(1);
}

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

async function run() {
    const url = process.env.SUPABASE_DB_URL;
    if (!url) {
        console.error(
            'No SUPABASE_DB_URL set.\n' +
            '  1. Copy .env.example to .env\n' +
            '  2. Fill in SUPABASE_DB_URL (Supabase dashboard → Project Settings → Database → Connection string → URI, Node.js)\n'
        );
        process.exit(1);
    }

    const ssl = process.env.SUPABASE_DB_SSL !== 'false';
    const pool = new Pool({
        connectionString: url,
        ssl: ssl ? { rejectUnauthorized: false } : false,
        connectionTimeoutMillis: 15000
    });

    const files = fs.readdirSync(MIGRATIONS_DIR)
        .filter(f => f.endsWith('.sql'))
        .sort();
    if (!files.length) {
        console.log('No migrations found in ' + MIGRATIONS_DIR);
        process.exit(0);
    }

    try {
        await pool.query(
            'CREATE TABLE IF NOT EXISTS schema_migrations (' +
            '  version    TEXT PRIMARY KEY,' +
            '  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()' +
            ')'
        );
    } catch (err) {
        dbGone(err);
    }

    const { rows } = await pool.query('SELECT version FROM schema_migrations');
    const applied = new Set(rows.map(r => r.version));

    let ran = 0;
    for (const f of files) {
        if (applied.has(f)) {
            console.log('skip  ' + f + '  (already applied)');
            continue;
        }
        const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8');
        console.log('apply ' + f + ' …');
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            await client.query(sql);
            await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [f]);
            await client.query('COMMIT');
            ran++;
        } catch (err) {
            await client.query('ROLLBACK');
            console.error('FAILED ' + f + ': ' + err.message);
            process.exit(1);
        } finally {
            client.release();
        }
    }

    console.log(ran ? 'done — ' + ran + ' migration(s) applied' : 'done — all migrations up to date');
    await pool.end();
}

run().catch(err => {
    if (DEPLOY_MODE) {
        console.log('[migrate] skipped (best-effort deploy mode): ' + err.message);
        process.exit(0);
    }
    console.error(err.message);
    process.exit(1);
});
