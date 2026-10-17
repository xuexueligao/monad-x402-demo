import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const root = fileURLToPath(new URL('..', import.meta.url));
const temporary = path.join(root, '.local', 'tmp');
mkdirSync(temporary, { recursive: true });
// Next.js ignores the custom env filename. Forward only browser-safe values.
const publicBuildEnv = {};
const arenaEnvFile = path.join(root, '.env.arena.local');
if (existsSync(arenaEnvFile)) {
  for (const [name, value] of Object.entries(dotenv.parse(readFileSync(arenaEnvFile)))) {
    if (name.startsWith('NEXT_PUBLIC_') && process.env[name] === undefined) publicBuildEnv[name] = value;
  }
}
const child = spawn(process.execPath, process.argv.slice(2), {
  cwd: root, windowsHide: true, stdio: 'inherit',
  env: { ...publicBuildEnv, ...process.env, TEMP: temporary, TMP: temporary, NODE_DISABLE_COMPILE_CACHE: '1', NEXT_TELEMETRY_DISABLED: '1' },
});
child.once('error', error => { console.error(error.message); process.exitCode = 1; });
child.once('exit', code => { process.exitCode = code || 0; });
process.once('SIGINT', () => child.kill());
process.once('SIGTERM', () => child.kill());
