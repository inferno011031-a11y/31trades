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

if (failures > 0) {
    console.error('UI Lint failed with ' + failures + ' error(s). Clean harsh white border classes before committing.');
    process.exit(1);
} else {
    console.log('All UI Anti-Pattern & Design Guard checks passed!');
    process.exit(0);
}
