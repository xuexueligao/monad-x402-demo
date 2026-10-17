import { io } from 'socket.io-client';
import { mkdir, writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';

// Bounded spectator test of the project-owned deployment. No POST, wallets or AI calls.
const origin = 'https://monad-rug-arena.onrender.com';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const percentile = (values, q) => values.length ? Math.round([...values].sort((a, b) => a - b)[Math.ceil(values.length * q) - 1]) : null;
const report = {
  startedAt: new Date().toISOString(), origin,
  scope: 'Real cloud HTTP GET + spectator WebSockets only. No player join, payments, AI requests or blockchain writes.',
  stages: [],
};
async function get(path) {
  const start = performance.now();
  try {
    const response = await fetch(origin + path, { signal: AbortSignal.timeout(8000) });
    const data = await response.json();
    return { ok: response.ok, status: response.status, latencyMs: performance.now() - start, data };
  } catch (error) {
    return { ok: false, status: 0, latencyMs: performance.now() - start, error: error.name };
  }
}
const baseline = await get('/api/health');
report.baseline = { status: baseline.status, latencyMs: Math.round(baseline.latencyMs), health: baseline.data || baseline.error };
console.log(JSON.stringify({ event: 'baseline', ...report.baseline }));
if (!baseline.ok) throw new Error('Cloud baseline unavailable; no load started.');

for (const count of [5, 15, 30]) {
  const sockets = [], connectTimes = [], latencies = [];
  let connected = 0, connectionErrors = 0, disconnects = 0, snapshots = 0;
  let requests = 0, errors = 0, rpcErrorSnapshots = 0, httpStateRpcErrors = 0, stop = false;
  const samples = [], pending = new Set();
  const stageStart = performance.now();
  try {
    for (let index = 0; index < count; index++) {
      const opened = performance.now();
      const socket = io(origin, { transports: ['websocket'], reconnection: false, timeout: 8000, autoConnect: false });
      socket.on('connect', () => { connected++; connectTimes.push(performance.now() - opened); });
      socket.on('connect_error', () => { connectionErrors++; });
      socket.on('disconnect', () => { if (!stop) disconnects++; });
      socket.on('snapshot', snapshot => {
        snapshots++;
        if (snapshot.chainError) rpcErrorSnapshots++;
        if (samples.length < 5) samples.push({ chainId: snapshot.chainId, contract: snapshot.contractAddress, rpcAvailable: !snapshot.chainError });
      });
      socket.connect(); sockets.push(socket);
      await sleep(200); // Five connection attempts per second maximum.
    }
    const poll = async () => {
      const result = await get('/api/game/state');
      requests++; latencies.push(result.latencyMs);
      if (!result.ok) errors++;
      if (result.data?.chainError) httpStateRpcErrors++;
      if (requests >= 5 && errors / requests > 0.1) stop = true;
    };
    const until = performance.now() + 12000;
    // Same aggregate GET rate as one state request per spectator every twelve seconds.
    while (!stop && performance.now() < until) {
      const task = poll().finally(() => pending.delete(task));
      pending.add(task);
      await sleep(12000 / count);
    }
    await Promise.allSettled([...pending]);
    const health = await get('/api/health');
    report.stages.push({
      spectators: count, elapsedMs: Math.round(performance.now() - stageStart), connected,
      connectionErrors, unexpectedDisconnects: disconnects, snapshots, rpcErrorSnapshots, httpStateRpcErrors,
      httpRequests: requests, httpErrors: errors, httpSuccessPercent: requests ? Math.round(10000 * (requests - errors) / requests) / 100 : 0,
      httpP50Ms: percentile(latencies, 0.5), httpP95Ms: percentile(latencies, 0.95),
      socketConnectP95Ms: percentile(connectTimes, 0.95), health: health.data || health.error,
      stoppedEarly: stop, samples,
    });
    console.log(JSON.stringify({ event: 'stage', ...report.stages.at(-1) }));
    if (stop || !health.ok) break;
  } finally {
    stop = true;
    for (const socket of sockets) socket.disconnect();
    await Promise.allSettled([...pending]);
  }
  await sleep(1000);
}
report.finishedAt = new Date().toISOString();
await mkdir('.local/evidence', { recursive: true });
await writeFile('.local/evidence/load-cloud-spectators.safe.json', JSON.stringify(report, null, 2));
console.log('Cloud spectator test complete; evidence: .local/evidence/load-cloud-spectators.safe.json');
