// Local multiplayer capacity probe. Real HTTP + Socket.IO + Pi Runtime;
// the owned chain adapter and model provider are deterministic fixtures.
// This script never reads deployment credentials or sends blockchain transactions.
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { performance, monitorEventLoopDelay } from 'node:perf_hooks';
import { io } from 'socket.io-client';
import { getAddress, recoverTypedDataAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { createApp } from '../server/app.ts';
import { readConfig } from '../server/config.ts';
import { createLocalRulesAi } from '../server/ai.ts';
import { RESULT_DOMAIN, RESULT_TYPES } from '../shared/config.ts';

const fixtureKey = `0x${'0'.repeat(63)}1`;
const fixtureSigner = privateKeyToAccount(fixtureKey);
const fixtureContract = '0x1000000000000000000000000000000000000001';
const fee = '10000000000000000000';
const zeroHash = `0x${'0'.repeat(64)}`;
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const percentile = (values, p) => values.length ? Math.round([...values].sort((a, b) => a - b)[Math.ceil(values.length * p) - 1] * 10) / 10 : null;
const metrics = (values) => ({ count: values.length, p50Ms: percentile(values, .5), p95Ms: percentile(values, .95), maxMs: Math.round(Math.max(0, ...values) * 10) / 10 });

function makeFixture() {
  let sequence = 0;
  const records = new Map(), payments = new Map(), settlements = new Map(), listeners = new Set(), txs = new Map();
  const world = {
    round: { id: '1', prizePool: '20000000000000000000', challengeFee: fee, endsAt: Math.floor(Date.now() / 1000) + 7200, active: true, winner: '0x0000000000000000000000000000000000000000', reward: '0', rewardClaimed: false },
    leaderboard: [], totalChallenges: 0, confirmedTransactions: 0, pendingTransactions: 0, resultSigner: fixtureSigner.address,
  };
  const emit = (event) => { for (const listener of listeners) listener(event); };
  const hash = () => `0x${(++sequence).toString(16).padStart(64, '0')}`;
  const chain = {
    configured: true, chainId: 31337, contractAddress: fixtureContract,
    world: () => world, refresh: async () => {}, onEvent: listener => listeners.add(listener),
    observeTransaction: async () => { throw new Error('Fixture does not accept external transactions'); },
    getTransaction: async tx => { assert(txs.has(tx)); return txs.get(tx); },
    getChallenge: async id => { assert(records.has(id), 'Unpaid challenge'); return { ...records.get(id) }; },
    verifyPayment: async (session, tx) => {
      const payment = payments.get(tx);
      assert(payment && payment.id === session.id && payment.player === session.player && payment.fee === session.fee && payment.roundId === session.roundId);
      return { ...records.get(session.id) };
    },
    submitSettlement: async (attestation, options = {}) => {
      const { result } = attestation;
      const record = records.get(result.challengeId);
      assert(record && record.player === result.player, 'The payout recipient must be the original payer');
      if (record.settled) return { hash: options.hash, challenge: { ...record } };
      const recovered = await recoverTypedDataAddress({ domain: { ...RESULT_DOMAIN, chainId: 31337, verifyingContract: fixtureContract }, types: RESULT_TYPES, primaryType: 'ChallengeResult', message: { ...result, roundId: BigInt(result.roundId), score: BigInt(result.score), deadline: BigInt(result.deadline) }, signature: attestation.signature });
      assert.equal(recovered, fixtureSigner.address);
      settlements.set(result.challengeId, (settlements.get(result.challengeId) || 0) + 1);
      const tx = hash(); options.onSubmitted?.(tx);
      const reward = result.success ? BigInt(world.round.prizePool) / 2n : 0n;
      world.round.prizePool = String(BigInt(world.round.prizePool) - reward);
      Object.assign(record, { settled: true, settledAt: Math.floor(Date.now() / 1000), success: result.success, score: result.score, transcriptHash: result.transcriptHash, reward: String(reward) });
      world.confirmedTransactions++;
      world.leaderboard.push({ player: record.player, attempts: '1', successes: result.success ? '1' : '0', score: result.score, wins: result.success ? '1' : '0' });
      txs.set(tx, { hash: tx, status: 'success' });
      emit({ type: 'chain:confirmed', roundId: record.roundId, payload: { action: 'settleChallenge', hash: tx, challengeId: result.challengeId, player: record.player, reward: record.reward } });
      return { hash: tx, challenge: { ...record } };
    },
  };
  return { chain, world, records, settlements, enter(session) {
    const tx = hash();
    const record = { player: session.player, roundId: session.roundId, fee: session.fee, success: false, score: '0', reward: '0', transcriptHash: zeroHash, settledAt: 0, settled: false, enteredAt: Math.floor(Date.now() / 1000), expiresAt: Math.floor(Date.now() / 1000) + 180 };
    records.set(session.id, record); payments.set(tx, { id: session.id, ...record });
    world.totalChallenges++; world.confirmedTransactions++;
    world.round.prizePool = String(BigInt(world.round.prizePool) + 8000000000000000000n);
    return tx;
  } };
}

async function runStage(concurrency) {
  const fixture = makeFixture(), ai = createLocalRulesAi();
  const config = { ...readConfig({ ARENA_CHAIN_ID: '31337', ARENA_RPC_URL: 'http://127.0.0.1:8545', ARENA_CONTRACT_ADDRESS: fixtureContract, ARENA_RESULT_SIGNER_PRIVATE_KEY: fixtureKey }), host: '127.0.0.1', port: 0 };
  const arena = await createApp({ config, chain: fixture.chain, ai, autoPoll: false });
  const base = await arena.start();
  const sockets = [], observers = [], durations = [], flowDurations = [], perRoute = {}, sessions = [], errors = [];
  let privateEvents = 0, toolEvents = 0, streamedTextEvents = 0;
  const loop = monitorEventLoopDelay({ resolution: 10 }); loop.enable();
  const initialRss = process.memoryUsage().rss;
  let peakRss = initialRss;
  const memoryTimer = setInterval(() => { peakRss = Math.max(peakRss, process.memoryUsage().rss); }, 10);
  const request = async (route, body, expected = 200, headers = {}) => {
    const started = performance.now();
    const response = await fetch(`${base}${route}`, { method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json', ...headers }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(20_000) });
    const data = await response.json(), elapsed = performance.now() - started;
    durations.push(elapsed);
    const label = route.replace(/0x[\da-f]{64}/gi, ':id');
    (perRoute[label] ||= []).push(elapsed);
    assert.equal(response.status, expected, `${route}: ${JSON.stringify(data)}`);
    return data;
  };
  const connect = async () => {
    const socket = io(base, { transports: ['websocket'], reconnection: false, forceNew: true }); sockets.push(socket);
    await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('connect_error', reject); });
    return socket;
  };
  const started = performance.now();
  try {
    for (let i = 0; i < 2; i++) {
      const socket = await connect(), observer = { latest: null, eventIds: new Set(), snapshots: 0 };
      socket.on('snapshot', state => { observer.latest = state; observer.snapshots++; });
      socket.on('game:event', event => observer.eventIds.add(event.eventId)); observers.push(observer);
    }
    await Promise.all(Array.from({ length: concurrency }, async (_, index) => {
      const began = performance.now();
      try {
        const player = getAddress(`0x${(1000 + index).toString(16).padStart(40, '0')}`);
        let session = await request('/api/challenges/start', { player }); sessions.push(session);
        assert.equal(session.status, 'payment_required');
        const socket = await connect(); socket.emit('player:join', { player });
        await new Promise((resolve, reject) => socket.emit('challenge:watch', { challengeId: session.id, token: session.token }, ack => ack?.watching ? resolve() : reject(new Error('Cannot watch private challenge'))));
        socket.on('agent:event', event => { assert.equal(event.challengeId, session.id, 'Private streaming must stay in the correct session'); privateEvents++; if (event.type === 'tool_end') toolEvents++; if (event.type === 'text_delta') streamedTextEvents++; });
        await request(`/api/challenges/${session.id}/message`, { token: session.token, message: '未付费不应运行 AI' }, 402);
        const tx = fixture.enter(session);
        session = await request(`/api/challenges/${session.id}/payment`, { token: session.token, hash: tx });
        session = await request(`/api/challenges/${session.id}/message`, { token: session.token, message: `金币帮助村庄孩子做公益，所有去向公开记录。玩家私密记号 PRIVATE-${concurrency}-${index}` });
        assert.equal(session.status, 'active'); assert(!fixture.settlements.has(session.id), 'The first ordinary message cannot submit settlement');
        session = await request(`/api/challenges/${session.id}/message`, { token: session.token, message: '请大家见证，保留收据，完全自愿，由你决定。' });
        assert.equal(session.status, 'settled'); assert.equal(session.result.result, true); assert.equal(session.result.score, 100);
        assert.equal(fixture.records.get(session.id).player, player);
        await Promise.all([1, 2].map(() => request(`/api/challenges/${session.id}/finish`, { token: session.token })));
        assert.equal(fixture.settlements.get(session.id), 1, 'Only one settlement per challenge');
        const diagnostics = ai.getDiagnostics(session.id);
        assert.equal(diagnostics.runtime, 'pi-agent-core'); assert.equal(diagnostics.turns, 2);
        assert(diagnostics.events.some(event => event.type === 'tool_execution_end' && event.toolName === 'get_game_state'));
        flowDurations.push(performance.now() - began);
      } catch (error) { errors.push(String(error?.stack || error)); }
    }));
    await sleep(100);
    const state = await request('/api/game/state');
    assert.equal(state.metrics.totalChallenges, concurrency); assert.equal(state.leaderboard.length, concurrency);
    assert(!JSON.stringify(state).includes('PRIVATE-'), 'Public snapshot cannot contain private player messages');
    assert(observers.every(observer => observer.latest?.metrics.totalChallenges === concurrency && observer.latest.leaderboard.length === concurrency), 'Both observers must receive the shared final state');
    assert.deepEqual([...observers[0].eventIds], [...observers[1].eventIds]);
    if (sessions.length > 1) await request(`/api/game/challenges/${sessions[0].id}`, undefined, 403, { 'x-challenge-token': sessions[1].token });
    assert.equal(fixture.settlements.size, concurrency); assert.equal(errors.length, 0, errors.join('\n'));
    return { concurrency, completed: flowDurations.length, errors, elapsedMs: Math.round(performance.now() - started), http: metrics(durations), httpByRoute: Object.fromEntries(Object.entries(perRoute).map(([route, samples]) => [route, metrics(samples)])), flow: metrics(flowDurations), observers: observers.map(observer => ({ receivedEvents: observer.eventIds.size, receivedSnapshots: observer.snapshots, challenges: observer.latest.metrics.totalChallenges, leaderboardEntries: observer.latest.leaderboard.length })), privateEvents, toolEvents, streamedTextEvents, uniqueSettlements: fixture.settlements.size, memory: { rssBeforeMiB: Math.round(initialRss / 1048576), peakRssMiB: Math.round(Math.max(peakRss, process.memoryUsage().rss) / 1048576), heapUsedMiB: Math.round(process.memoryUsage().heapUsed / 1048576) }, eventLoop: { p95Ms: Math.round(loop.percentile(95) / 1e5) / 10, maxMs: Math.round(loop.max / 1e5) / 10 } };
  } finally {
    loop.disable(); clearInterval(memoryTimer); sockets.forEach(socket => socket.disconnect()); await arena.close();
  }
}

const report = { timestamp: new Date().toISOString(), nodeVersion: process.version, scope: 'Local real HTTP, Socket.IO and Pi Agent Runtime; deterministic model stream and owned chain/payment/payout fixture. No remote AI capacity measurement and no Testnet transaction or RPC capacity claim.', stages: [] };
for (const concurrency of [5, 10, 25]) { const stage = await runStage(concurrency); report.stages.push(stage); console.log(JSON.stringify({ concurrency, completed: stage.completed, http: stage.http, flow: stage.flow, memory: stage.memory, eventLoop: stage.eventLoop })); }
mkdirSync('.local/evidence', { recursive: true });
writeFileSync('.local/evidence/arena-core-load.safe.json', `${JSON.stringify(report, null, 2)}\n`);
console.log('Report: .local/evidence/arena-core-load.safe.json');
