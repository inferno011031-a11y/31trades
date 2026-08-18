/** @type {import('tailwindcss').Config} */
module.exports = {
    "darkMode": [
      "class"
    ],
    "content": [
      "./*.html",
      "./*.js",
      "./assets/**/*.js",
      "./src/**/*.js"
    ],
    "theme": {
      "extend": {
        "colors": {
          "tm-bg": "var(--tm-bg)",
          "tm-bg-elev": "var(--tm-bg-elev)",
          "tm-card": "var(--tm-card)",
          "tm-card-2": "var(--tm-card-2)",
          "tm-hover": "var(--tm-hover)",
          "tm-text": "var(--tm-text)",
          "tm-muted": "var(--tm-muted)",
          "tm-dim": "var(--tm-dim)",
          "tm-accent": "var(--tm-accent)",
          "tm-accent-2": "var(--tm-accent-2)",
          "tm-green": "var(--tm-green)",
          "tm-red": "var(--tm-red)",
          "tm-amber": "var(--tm-amber)",
          "tm-blue": "var(--tm-blue)",
          // Keyed 'tm-line' not 'tm-border': a token name containing '-border'
          // collides with Tailwind's border-{width} parser, so utilities using
          // it never generate. These map to var(--tm-border)/var(--tm-border-2).
          "tm-line": "var(--tm-border)",
          "tm-line-2": "var(--tm-border-2)"
        },
        "fontFamily": {
          "sans": [
            "Plus Jakarta Sans",
            "ui-sans-serif",
            "system-ui"
          ],
          "mono": [
            "JetBrains Mono",
            "ui-monospace",
            "Menlo",
            "Consolas"
          ]
        }
      }
    },
  plugins: [],
}
