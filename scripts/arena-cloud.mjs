import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const root = fileURLToPath(new URL('..', import.meta.url));
dotenv.config({ path: path.join(root, '.env.arena.local'), override: false, quiet: true });
dotenv.config({ path: path.join(root, '.env'), override: false, quiet: true });
const standalone = path.join(root, '.next', 'standalone');
if (!existsSync(path.join(standalone, 'server.js'))) throw new Error('Run npm run build before starting the cloud service.');

function copyAssets(source, destination) {
  mkdirSync(destination, { recursive: true });
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name), to = path.join(destination, entry.name);
    if (entry.isDirectory()) copyAssets(from, to);
    else writeFileSync(to, readFileSync(from));
  }
}
copyAssets(path.join(root, 'public'), path.join(standalone, 'public'));
copyAssets(path.join(root, '.next', 'static'), path.join(standalone, '.next', 'static'));

const publicPort = process.env.ARENA_GATEWAY_PORT || process.env.PORT || '4100';
const env = { ...process.env, NODE_ENV: 'production', NEXT_TELEMETRY_DISABLED: '1' };
const publicUrl = env.RENDER_EXTERNAL_URL || env.FRONTEND_URL;
if (publicUrl) {
  const origin = new URL(publicUrl).origin;
  env.PUBLIC_JOIN_URL = `${origin}/play`;
  env.ARENA_ALLOWED_ORIGINS = [...new Set([...(env.ARENA_ALLOWED_ORIGINS || '').split(',').filter(Boolean), origin])].join(',');
}
const children = [];
let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  process.exitCode = code;
  for (const child of children) { if (child.exitCode === null) child.kill('SIGTERM'); }
  const timer = setTimeout(() => { for (const child of children) { if (child.exitCode === null) child.kill('SIGKILL'); } }, 5000);
  timer.unref();
}
function launch(args, overrides) {
  const child = spawn(process.execPath, args, { cwd: root, env: { ...env, ...overrides }, stdio: 'inherit', windowsHide: true });
  children.push(child);
  child.once('error', () => { console.error('An Arena child service could not start.'); stop(1); });
  child.once('exit', (code, signal) => { if (!stopping) { console.error(`An Arena child service stopped (${signal || code || 0}).`); stop(code || 1); } });
}
launch(['--import', 'tsx', 'server/index.ts'], { API_HOST: '127.0.0.1', API_PORT: '4000', PORT: '4000' });
launch([path.join(standalone, 'server.js')], { HOSTNAME: '127.0.0.1', PORT: '3150' });
launch(['scripts/arena-gateway.mjs'], { ARENA_GATEWAY_PORT: publicPort, PORT: publicPort });
process.once('SIGINT', () => stop());
process.once('SIGTERM', () => stop());
console.log(`MONAD RUG ARENA cloud service starting on public port ${publicPort}`);
