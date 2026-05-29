/// <reference types="vite/client" />

// Build-time constants injected by Vite's `define` (see vite.config.ts).
// Stamped from the git short SHA + UTC build date so the deployed app
// can show a tiny version string. Defaults to 'dev' / today's date when
// built outside CI (no git history / fresh checkout / dev container).
declare const __APP_VERSION_SHA__: string;
declare const __APP_VERSION_DATE__: string;
