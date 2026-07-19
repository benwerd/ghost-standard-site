// Shared .dev.vars reader for the deploy-time scripts. .dev.vars is the
// single source of truth for all configuration (see README); these scripts
// read it directly rather than taking their own flags so values can never
// drift between local dev, deploy config, and production secrets.
import fs from 'node:fs';

/** Where the runtime configuration lives (gitignored; copy from .dev.vars.example). */
export const DEV_VARS = '.dev.vars';

/**
 * Parse .dev.vars into a key→value map, skipping comments and blank lines.
 * Exits the process with guidance if the file doesn't exist yet, so every
 * consuming script fails the same friendly way.
 */
export function readDevVars() {
  if (!fs.existsSync(DEV_VARS)) {
    console.error(`${DEV_VARS} not found. Run: cp .dev.vars.example ${DEV_VARS} and fill it in.`);
    process.exit(1);
  }
  return Object.fromEntries(
    fs.readFileSync(DEV_VARS, 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#') && line.includes('='))
      .map((line) => {
        const eq = line.indexOf('=');
        return [line.slice(0, eq).trim(), line.slice(eq + 1).trim()];
      })
  );
}
