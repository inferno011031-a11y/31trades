/* ============================================================================
   31TRADES — Tailwind CDN runtime config
   Loaded immediately AFTER <script src="https://cdn.tailwindcss.com"></script>
   on every page. Maps the app's canonical design tokens (defined once in
   assets/trademind-theme.css) onto Tailwind utilities, so markup can use
   bg-tm-card, text-tm-muted, border-tm-border, font-tm-mono, etc. instead of
   hardcoded hex values.

   The static tailwind.config.js at the project root carries the same tokens
   for a future compiled-Tailwind build; keep both in sync with the theme file.
   ============================================================================ */
if (window.tailwind) {
    tailwind.config = {
        darkMode: 'class',
        theme: {
            extend: {
                colors: {
                    'tm-bg':       'var(--tm-bg)',
                    'tm-bg-elev':  'var(--tm-bg-elev)',
                    'tm-card':     'var(--tm-card)',
                    'tm-card-2':   'var(--tm-card-2)',
                    'tm-hover':    'var(--tm-hover)',
                    'tm-text':     'var(--tm-text)',
                    'tm-muted':    'var(--tm-muted)',
                    'tm-dim':      'var(--tm-dim)',
                    'tm-accent':   'var(--tm-accent)',
                    'tm-accent-2': 'var(--tm-accent-2)',
                    'tm-green':    'var(--tm-green)',
                    'tm-red':      'var(--tm-red)',
                    'tm-amber':    'var(--tm-amber)',
                    'tm-blue':     'var(--tm-blue)',
                    /* NOTE: tokens are keyed 'tm-line' (not 'tm-border') because a
                       token name containing '-border' collides with Tailwind's
                       border-{width} parser and the utility never generates.
                       They still map to var(--tm-border) / var(--tm-border-2). */
                    'tm-line':     'var(--tm-border)',
                    'tm-line-2':   'var(--tm-border-2)'
                },
                fontFamily: {
                    sans: ['Plus Jakarta Sans', 'ui-sans-serif', 'system-ui', 'sans-serif'],
                    mono: ['JetBrains Mono', 'ui-monospace', 'Menlo', 'Consolas', 'monospace']
                }
            }
        }
    };
}
