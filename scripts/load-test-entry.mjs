import { randomBytes } from 'node:crypto';
import { writeFile, mkdir } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';

// Creates private, unpaid challenge invoices only. Never submits a payment or message.
const origin = 'https://monad-rug-arena.onrender.com';
const report = { startedAt: new Date().toISOString(), origin, scope: 'Actual cloud start endpoint; fresh test addresses, unpaid private sessions only. No wallet, AI, payment or settlement.', stages: [] };
const percentile = (values, q) => values.length ? Math.round([...values].sort((a, b) => a - b)[Math.ceil(values.length * q) - 1]) : null;
const baseline = await fetch(origin + '/api/game/state', { signal: AbortSignal.timeout(10000) }).then(r => r.json());
report.before = { pool: baseline.round.prizePool, totalChallenges: baseline.metrics.totalChallenges };
if (!baseline.round.active || baseline.round.endsAt * 1000 < Date.now()) throw new Error('Round closed; no start load generated.');
for (const concurrency of [1, 5, 10]) {
  const started = performance.now();
  const results = await Promise.all(Array.from({ length: concurrency }, async () => {
    const start = performance.now();
    const player = '0x' + randomBytes(20).toString('hex');
    try {
      const response = await fetch(origin + '/api/challenges/start', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ player }), signal: AbortSignal.timeout(12000) });
      const data = await response.json();
      return { status: response.status, ok: response.ok && data.status === 'payment_required', latencyMs: performance.now() - start, rateLimited: /15\/sec|429|rate.limit|requests limited/i.test(data.error || ''), ...(response.ok ? {} : { error: String(data.error || 'Request failed').split('\n')[0].slice(0, 180) }) };
    } catch (error) { return { status: 0, ok: false, latencyMs: performance.now() - start, error: error.name }; }
  }));
  const passed = results.filter(r => r.ok).length;
  const stage = { concurrency, passed, failed: concurrency - passed, rpcLimitErrors: results.filter(r => r.rateLimited).length, p50Ms: percentile(results.map(r => r.latencyMs), .5), p95Ms: percentile(results.map(r => r.latencyMs), .95), elapsedMs: Math.round(performance.now() - started), statuses: results.map(r => r.status), errors: results.filter(r => !r.ok).map(r => r.error) };
  report.stages.push(stage); console.log(JSON.stringify(stage));
  if (stage.failed) break; // One failure is enough evidence; do not sustain failing load.
  await new Promise(resolve => setTimeout(resolve, 2000));
}
const after = await fetch(origin + '/api/game/state', { signal: AbortSignal.timeout(10000) }).then(r => r.json());
report.after = { pool: after.round.prizePool, totalChallenges: after.metrics.totalChallenges, chainError: after.chainError || null };
report.noChainChangeObserved = report.before.pool === report.after.pool && report.before.totalChallenges === report.after.totalChallenges;
report.finishedAt = new Date().toISOString();
await mkdir('.local/evidence', { recursive: true });
await writeFile('.local/evidence/load-cloud-entry.safe.json', JSON.stringify(report, null, 2));
console.log(JSON.stringify({ event: 'done', noChainChangeObserved: report.noChainChangeObserved }));
