// The release audits are text scans over every tracked or new non-ignored file,
// so ESLint is configured for the whole tree, not just JavaScript. The ignore
// list mirrors .gitignore (the audits use `git ls-files -co --exclude-standard`)
// plus ESLint's own defaults.
import { gameCatPlugin } from "./eslint/plugin.js";

export default [
  {
    ignores: [
      "**/.git",
      "**/.git/**",
      "**/node_modules/",
      "**/dist/",
      "**/build/",
      "**/coverage/",
      "**/test-results/",
      "**/playwright-report/",
      "**/.data/",
      "**/*.sqlite",
      "**/*.sqlite-*",
      "**/.env",
      "**/.env.*",
      "**/.DS_Store",
      "**/.idea/",
    ],
  },
  {
    // A non-universal pattern is required for ESLint to lint files whose
    // extension it does not know; the brace expansion matches every path.
    files: ["**/*{,.*}"],
    plugins: { "game-cat": gameCatPlugin },
    processor: "game-cat/text",
    rules: {
      "game-cat/no-secret-values": "error",
    },
  },
  {
    files: ["tests/**/*.{ts,tsx,mjs,cjs,js,jsx}"],
    rules: {
      "game-cat/no-focused-or-skipped-tests": "error",
    },
  },
];
