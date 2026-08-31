'use strict';

// ============================================================================
// AI-EVAL — run-all.js
// Single entry point: npm run test:ai
// ============================================================================
// Runs all test modules sequentially. Collects pass/fail counts. Exits with
// code 1 if any failures, 0 on full pass. No third-party test framework.
//
// Execution order:
//   1. Fixture sanity    — all 12 fixtures build without error
//   2. Engine tests      — mentor-bundle, detect-patterns, psychology,
//                          risk-analysis, discipline-coach, session-intel,
//                          tilt-analysis, evidence-floor
//   3. Chat tests        — intent-detection, context-resolution, ask-scripted
//   4. Narration         — grounding-guard
// ============================================================================

const path = require('node:path');

const MODULES = [
    // ---- Fixture sanity -------------------------------------------------------
    { label: 'Fixture sanity',       file: './fixture-sanity.js' },
    // ---- Engine tests ---------------------------------------------------------
    { label: 'mentor-bundle',        file: './engines/mentor-bundle.test.js' },
    { label: 'detect-patterns',      file: './engines/detect-patterns.test.js' },
    { label: 'psychology',           file: './engines/psychology.test.js' },
    { label: 'risk-analysis',        file: './engines/risk-analysis.test.js' },
    { label: 'discipline-coach',     file: './engines/discipline-coach.test.js' },
    { label: 'session-intel',        file: './engines/session-intel.test.js' },
    { label: 'tilt-analysis',        file: './engines/tilt-analysis.test.js' },
    { label: 'evidence-floor',       file: './engines/evidence-floor.test.js' },
    // ---- Chat tests ----------------------------------------------------------
    { label: 'intent-detection',     file: './chat/intent-detection.test.js' },
    { label: 'context-resolution',   file: './chat/context-resolution.test.js' },
    { label: 'ask-scripted',         file: './chat/ask-scripted.test.js' },
    { label: 'long-memory',          file: './chat/long-memory.test.js' },
    // ---- Narration -----------------------------------------------------------
    { label: 'grounding-guard',      file: './narration/grounding-guard.test.js' },
    // ---- RAG & Knowledge Base ------------------------------------------------
    { label: 'rag-engine',           file: './rag/rag.test.js' },
    { label: 'ai-rag-integration',   file: './rag/ai-rag-integration.test.js' }
];

const W  = process.stdout.columns || 80;
const HR = '─'.repeat(Math.min(W, 72));

let totalPass = 0;
let totalFail = 0;
const failedModules = [];

async function runModule(mod) {
    console.log('\n' + HR);
    console.log('  ▶  ' + mod.label);
    console.log(HR);

    let results;
    try {
        results = require(mod.file);
        if (results instanceof Promise) {
            results = await results;
        }
    } catch (e) {
        console.log('  CRASH  ' + mod.label + ' — ' + e.message);
        totalFail++;
        failedModules.push(mod.label + ' [CRASHED: ' + e.message + ']');
        return;
    }

    // Some test files use async internally (grounding-guard). Give them a tick
    // to schedule async checks. Sync results are already in the array.
    let pass = 0, fail = 0;
    (results || []).forEach(r => {
        if (r.ok) {
            pass++;
            console.log('  ok    ' + r.label);
        } else {
            fail++;
            console.log('  FAIL  ' + r.label + (r.extra ? '  — ' + r.extra : ''));
        }
    });

    totalPass += pass;
    totalFail += fail;
    if (fail > 0) failedModules.push(mod.label + ' (' + fail + ' failures)');

    console.log('  ' + pass + ' passed, ' + fail + ' failed');
}

// ---- Run all modules sequentially -------------------------------------------
async function main() {
    for (const mod of MODULES) {
        await runModule(mod);
    }

    // ---- Final summary ----------------------------------------------------------
    console.log('\n' + '═'.repeat(Math.min(W, 72)));
    console.log('  AI-EVAL RESULTS');
    console.log('═'.repeat(Math.min(W, 72)));
    console.log('  Total passed : ' + totalPass);
    console.log('  Total failed : ' + totalFail);
    if (failedModules.length > 0) {
        console.log('\n  Failed modules:');
        failedModules.forEach(m => console.log('    ✗ ' + m));
    }
    console.log('═'.repeat(Math.min(W, 72)));

    if (totalFail > 0) {
        console.log('\n  ✗ FAILED — ' + totalFail + ' check(s) did not pass\n');
        process.exit(1);
    } else {
        console.log('\n  ✓ ALL CHECKS PASSED\n');
        process.exit(0);
    }
}

main().catch(err => {
    console.error('Fatal test runner crash: ', err);
    process.exit(1);
});
