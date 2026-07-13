// Shared .dev.vars reader for the deploy-time scripts.
import fs from 'node:fs';

export const DEV_VARS = '.dev.vars';

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
