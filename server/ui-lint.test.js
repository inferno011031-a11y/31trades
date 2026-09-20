'use strict';

const fs = require('node:fs');
const path = require('node:path');

let failures = 0;
function check(label, cond, extra) {
    console.log((cond ? '  ok   ' : '  FAIL ') + label + (cond ? '' : '  — ' + (extra || '')));
    if (!cond) failures++;
}

console.log('UI Anti-Pattern & Design Guard Linter:');

const rootDir = path.resolve(__dirname, '..');
const htmlFiles = fs.readdirSync(rootDir)
    .filter(f => f.endsWith('.html'))
    .map(f => path.join(rootDir, f));

// Guard 1: Check calendar.html and core pages for harsh uncompiled white border classes
const forbiddenPatterns = [
    { regex: /border-white\[0\./g, name: 'Uncompiled arbitrary border-white/[...] (renders as solid white line)' },
    { regex: /divide-white\[0\./g, name: 'Uncompiled arbitrary divide-white/[...] (renders as solid white dividers)' },
    { regex: /border-b\s+border-white\[/g, name: 'Uncompiled arbitrary border-b border-white/[...]' },
    { regex: /border-t\s+border-white\[/g, name: 'Uncompiled arbitrary border-t border-white/[...]' },
    { regex: /h-[0-9]+\s+w-px\s+bg-white\/10/g, name: 'Solid white vertical divider (bg-white/10)' }
];

htmlFiles.forEach(file => {
    const base = path.basename(file);
    // Focus strictly on core active application pages
    if (['calendar.html', 'backtesting.html'].includes(base)) {
        const content = fs.readFileSync(file, 'utf8');
        forbiddenPatterns.forEach(pat => {
            const matches = content.match(pat.regex);
            check(base + ' has zero ' + pat.name, !matches || matches.length === 0, matches ? 'found ' + matches.length + ' instances' : '');
        });
    }
});

// Guard 2: Verify calendar.html has defensive CSS rule for dark borders
const calContent = fs.readFileSync(path.join(rootDir, 'calendar.html'), 'utf8');
check('calendar.html includes STRICT GUARD dark border overrides', calContent.includes('STRICT GUARD: Zero white borders'));

// Guard 3: --tm-accent-2 is a SURFACE token (#18181b in the dark theme). Using it
// as a foreground paints invisible text/icons, which silently shipped on several
// pages. Foreground indigo must be --tm-indigo (CSS) or .fg-indigo (markup / JS).
// Backgrounds and gradients are legitimate uses and are NOT flagged.
const foregroundMisuse = [
    { regex: /(?:^|[^-])color\s*:\s*var\(\s*--tm-accent-2\s*\)/, name: 'color: var(--tm-accent-2)' },
    { regex: /\b(?:text|fill|stroke)-\[var\(\s*--tm-accent-2\s*\)\]/, name: 'text-[var(--tm-accent-2)] utility' },
    // Restricted to paint keys: a palette mapping such as
    // "'tm-accent-2': 'var(--tm-accent-2)'" in tailwind-config.js is a definition,
    // not a paint site, and mapping the token is legitimate.
    { regex: /\b(?:c|color|fg|fgColor|foreground|text|icon|stroke|fill|border)\s*:\s*'var\(\s*--tm-accent-2\s*\)'/, name: "JS paint map 'var(--tm-accent-2)'" },
    { regex: /box-shadow\s*:[^;'"\n]*var\(\s*--tm-accent-2\s*\)/, name: 'box-shadow accent using var(--tm-accent-2)' }
];

// tailwind-compiled.css is generated output (it still carries the now-unused
// .text-[var(--tm-accent-2)] utility), so it is excluded from the source scan.
const sourceFiles = [
    ...htmlFiles,
    ...fs.readdirSync(path.join(rootDir, 'assets'))
        .filter(f => (f.endsWith('.css') || f.endsWith('.js')) && f !== 'tailwind-compiled.css')
        .map(f => path.join(rootDir, 'assets', f))
];

sourceFiles.forEach(file => {
    const rel = path.relative(rootDir, file).replace(/\\/g, '/');
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
    const hits = [];
    lines.forEach((line, i) => {
        foregroundMisuse.forEach(pat => {
            if (pat.regex.test(line)) hits.push(rel + ':' + (i + 1) + ' ' + pat.name);
        });
    });
    check(rel + ' uses --tm-accent-2 only as a surface, never as a foreground',
        hits.length === 0,
        hits.length ? hits.join(' | ') + '  → use --tm-indigo / .fg-indigo' : '');
});

// Guard 4: an unbalanced inline <style> block silently kills every rule after the
// break point, because the browser folds the rest of the sheet into the unclosed
// rule. That is how ~35 rules went missing from help.html unnoticed.
htmlFiles.forEach(file => {
    const base = path.basename(file);
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
    let inStyle = false, inComment = false, depth = 0, minDepth = 0, startLine = 0;
    const problems = [];
    lines.forEach((line, i) => {
        if (!inStyle && /<style[ >]/.test(line)) {
            inStyle = true; inComment = false; depth = 0; minDepth = 0; startLine = i + 1;
        }
        if (!inStyle) return;
        for (let j = 0; j < line.length; j++) {
            if (!inComment && line[j] === '/' && line[j + 1] === '*') { inComment = true; j++; continue; }
            if (inComment && line[j] === '*' && line[j + 1] === '/') { inComment = false; j++; continue; }
            if (inComment) continue;
            if (line[j] === '{') depth++;
            if (line[j] === '}') { depth--; if (depth < minDepth) minDepth = depth; }
        }
        if (/<\/style>/.test(line)) {
            if (depth !== 0 || minDepth < 0) problems.push('style@' + startLine + ' end=' + depth + ' min=' + minDepth);
            inStyle = false;
        }
    });
    check(base + ' inline <style> blocks are brace-balanced', problems.length === 0,
        problems.join(' | ') + '  → every rule after the break is silently dropped');
});

// Guard: every arbitrary/variant Tailwind utility used in markup must exist in
// the compiled stylesheet.
// ----------------------------------------------------------------------------
// tailwind-compiled.css is a BUILD ARTIFACT — a class is only in it if it was in
// the source when the build last ran. Editing markup without re-running the build
// leaves classes like `min-h-[100dvh]` or `bg-[#06090e]` doing nothing, silently,
// with no console error and no visual clue beyond "the UI looks off".
// Before the build was re-run this guard found 401 such utilities on 28 pages.
{
    const compiledPath = path.join(rootDir, 'assets', 'tailwind-compiled.css');
    const compiled = fs.existsSync(compiledPath) ? fs.readFileSync(compiledPath, 'utf8') : '';
    const BS = String.fromCharCode(92);
    const SPECIALS = '.[]:,/%!()#&*+~>';
    const cssEscape = c => '.' + c.split('').map(ch => (SPECIALS.indexOf(ch) !== -1 ? BS + ch : ch)).join('');

    check('assets/tailwind-compiled.css exists', compiled.length > 1000,
        compiled.length + ' bytes');

    const unresolved = [];
    htmlFiles.forEach(file => {
        const base = path.basename(file);
        const markup = fs.readFileSync(file, 'utf8')
            .replace(/<script[\s\S]*?<\/script>/gi, '')   // class strings built in JS are not markup
            .replace(/<style[\s\S]*?<\/style>/gi, '');
        for (const m of markup.matchAll(/class="([^"]+)"/g)) {
            for (const cls of m[1].split(/\s+/)) {
                if (!cls || !/[\[\]:]/.test(cls)) continue;     // plain utilities are always emitted
                if (/['"(){}<>]/.test(cls)) continue;            // interpolated / non-class tokens
                if (cls.indexOf('data-') === 0) continue;
                if (!compiled.includes(cssEscape(cls))) unresolved.push(base + ' :: ' + cls);
            }
        }
    });
    check('every arbitrary Tailwind utility in markup is compiled', unresolved.length === 0,
        unresolved.length + ' unresolved: ' + unresolved.slice(0, 6).join(' | ') +
        '  → run: npm run build:css');
}

if (failures > 0) {
    console.error('UI Lint failed with ' + failures + ' error(s). Clean harsh white border classes before committing.');
    process.exit(1);
} else {
    console.log('All UI Anti-Pattern & Design Guard checks passed!');
    process.exit(0);
}
