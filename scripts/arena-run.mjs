import { spawn } from 'node:child_process';
import { mkdirSync, existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import dotenv from 'dotenv';

const root = fileURLToPath(new URL('..', import.meta.url));
dotenv.config({ path: path.join(root, '.env.arena.local'), quiet: true });
const task = process.argv[2] || 'dev';
const temporary = path.join(root, '.local', 'tmp');
mkdirSync(temporary, { recursive: true });
const env = { ...process.env, TEMP: temporary, TMP: temporary, NODE_DISABLE_COMPILE_CACHE: '1', NEXT_TELEMETRY_DISABLED: '1' };
const interfaces = Object.entries(os.networkInterfaces()).sort(([a], [b]) => {
  const rank = (name) => /wlan|wi-fi|无线/i.test(name) ? 0 : /ethernet|以太网/i.test(name) && !/virtual|vethernet/i.test(name) ? 1 : 2;
  return rank(a) - rank(b);
});
const lan = interfaces.flatMap(([, entries]) => entries || []).find(item => item.family === 'IPv4' && !item.internal && /^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(item.address))?.address;
if (lan) {
  if (!env.PUBLIC_JOIN_URL || env.PUBLIC_JOIN_URL.includes('localhost')) env.PUBLIC_JOIN_URL = `http://${lan}:3150/play`;
  env.ARENA_ALLOWED_ORIGINS = [...new Set([...(env.ARENA_ALLOWED_ORIGINS || 'http://localhost:3150,http://127.0.0.1:3150').split(','), `http://${lan}:3150`])].join(',');
}
const processes = [];
function copyAssets(source, destination) {
  mkdirSync(destination, { recursive: true });
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name), to = path.join(destination, entry.name);
    if (entry.isDirectory()) copyAssets(from, to);
    else writeFileSync(to, readFileSync(from));
  }
}
const launch = (args) => {
  const child = spawn(process.execPath, args, { cwd: root, env, stdio: 'inherit', windowsHide: true });
  processes.push(child);
  child.on('error', error => { console.error(error.message); stop(1); });
  child.on('exit', code => { if (code) stop(code); });
};
function stop(code = 0) { for (const child of processes) child.kill(); process.exitCode = code; }
process.on('SIGINT', () => stop());
process.on('SIGTERM', () => stop());
if (['dev', 'server', 'server:prod'].includes(task)) {
  if (!existsSync(path.join(root, 'contracts', 'abi', 'RugArena.json'))) throw new Error('先运行 npm run contracts:compile');
  launch(['--import', 'tsx', 'server/index.ts']);
}
if (['dev', 'web', 'start'].includes(task)) {
  if (task === 'start') {
    const standalone = path.join(root, '.next', 'standalone');
    if (!existsSync(path.join(standalone, 'server.js'))) throw new Error('先运行 npm run build 生成生产版本。');
    copyAssets(path.join(root, 'public'), path.join(standalone, 'public'));
    copyAssets(path.join(root, '.next', 'static'), path.join(standalone, '.next', 'static'));
    env.PORT = '3150'; env.HOSTNAME = '0.0.0.0';
    launch([path.join(standalone, 'server.js')]);
  } else launch(['node_modules/next/dist/bin/next', 'dev', '--hostname', '0.0.0.0', '--port', '3150']);
}
if (!['dev', 'server', 'server:prod', 'web', 'start'].includes(task)) throw new Error('Unknown task');
console.log(`MONAD RUG ARENA · http://localhost:3150${lan ? ` · LAN http://${lan}:3150` : ''}`);
