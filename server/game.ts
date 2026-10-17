import { randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { getAddress, keccak256, stringToHex, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { GAME_RULES, RESULT_DOMAIN, RESULT_TYPES } from '../shared/config';
import type { ChallengeSession, GameEvent, GameSnapshot } from '../shared/types';
import type { AiService } from './ai';
import type { ChainAdapter, ChainChallenge } from './chain';
import type { ServerConfig } from './config';
import type { PrivateAgentEvent } from '../apps/server/src/agent/game-tools';

export class ApiError extends Error {
  constructor(public statusCode: number, message: string) { super(message); }
}
export interface GameOptions { now?: () => number }
const finished = (session: ChallengeSession) => session.status === 'settled';

export class ArenaGame {
  private readonly sessions = new Map<string, ChallengeSession>();
  private readonly players = new Map<string, string>();
  private readonly locks = new Map<string, Promise<unknown>>();
  private readonly online = new Map<string, string>();
  private readonly events: GameEvent[] = [];
  private readonly sinks = new Set<(event: GameEvent) => void>();
  private readonly privateSinks = new Set<(id: string, event: PrivateAgentEvent) => void>();
  private readonly retryAfter = new Map<string, number>();
  private readonly account;
  private readonly now: () => number;
  private chainError?: string;

  constructor(readonly config: ServerConfig, readonly chain: ChainAdapter, readonly ai: AiService, options: GameOptions = {}) {
    this.now = options.now || Date.now;
    this.account = config.signerKey ? privateKeyToAccount(config.signerKey) : undefined;
    this.restore();
    chain.onEvent((event) => {
      if (event.type === 'chain:confirmed' && event.payload.action === 'settleChallenge' && typeof event.payload.challengeId === 'string') {
        const session = this.sessions.get(event.payload.challengeId);
        if (session) {
          session.status = 'settled';
          if (typeof event.payload.hash === 'string') session.settlementHash = event.payload.hash as Hex;
          if (typeof event.payload.reward === 'string') session.reward = event.payload.reward;
          session.settlementError = undefined;
          this.release(session);
          this.persist();
        }
      }
      this.publish(event.type, event.payload, event.roundId);
    });
  }
  private restore() {
    if (!this.config.sessionStorePath || !existsSync(this.config.sessionStorePath)) return;
    const saved = JSON.parse(readFileSync(this.config.sessionStorePath, 'utf8'));
    if (saved.chainId !== this.chain.chainId || saved.contract?.toLowerCase() !== this.chain.contractAddress?.toLowerCase()) return;
    for (const session of saved.sessions as ChallengeSession[]) {
      if (!session.id || !session.token || !session.fee || !Array.isArray(session.messages)) continue;
      this.sessions.set(session.id, session);
      if (!finished(session)) this.players.set(session.player.toLowerCase(), session.id);
    }
  }
  private persist() {
    if (!this.config.sessionStorePath) return;
    const path = resolve(this.config.sessionStorePath);
    mkdirSync(dirname(path), { recursive: true });
    const temporary = `${path}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify({ version: 1, chainId: this.chain.chainId, contract: this.chain.contractAddress, sessions: [...this.sessions.values()] }), { mode: 0o600 });
    renameSync(temporary, path);
  }
  private release(session: ChallengeSession) {
    if (this.players.get(session.player.toLowerCase()) === session.id) this.players.delete(session.player.toLowerCase());
  }
  onEvent(sink: (event: GameEvent) => void) { this.sinks.add(sink); }
  onPrivateEvent(sink: (id: string, event: PrivateAgentEvent) => void) { this.privateSinks.add(sink); }
  private publish(type: string, payload: Record<string, unknown>, roundId = this.chain.world().round.id) {
    const event: GameEvent = { eventId: randomBytes(16).toString('hex'), type, timestamp: this.now(), roundId, payload };
    this.events.unshift(event);
    if (this.events.length > 80) this.events.length = 80;
    for (const sink of this.sinks) sink(event);
  }
  async refresh() {
    try { await this.chain.refresh(); this.chainError = undefined; }
    catch (error) { this.chainError = error instanceof Error ? error.message : 'RPC is unavailable.'; }
  }
  async recoverSettlements() {
    // Resume persisted broadcasts and expire abandoned paid games, without a second player payment.
    for (const session of this.sessions.values()) {
      if (!session.paymentHash || finished(session) || (this.retryAfter.get(session.id) || 0) > this.now()) continue;
      if (session.status === 'active' && this.now() < session.expiresAt) continue;
      this.retryAfter.set(session.id, this.now() + 30_000);
      await this.locked(`session:${session.id}`, async () => {
        if (!finished(session)) await this.resolveAndSettle(session);
      }).catch(() => {});
    }
  }
  snapshot(): GameSnapshot {
    const world = this.chain.world();
    return {
      configured: this.chain.configured, chainId: this.chain.chainId, contractAddress: this.chain.contractAddress || null,
      aiMode: this.ai.mode, round: { ...world.round }, leaderboard: world.leaderboard,
      metrics: { totalChallenges: world.totalChallenges, activeWallets: new Set(this.online.values()).size, confirmedTransactions: world.confirmedTransactions, pendingTransactions: world.pendingTransactions },
      events: [...this.events], joinUrl: this.config.joinUrl,
      ...(world.relayerAddress ? { relayer: { address: world.relayerAddress, balance: world.relayerBalance || '0', ready: BigInt(world.relayerBalance || '0') > 0n && getAddress(world.resultSigner || world.relayerAddress) === world.relayerAddress } } : {}),
      ...(this.chainError ? { chainError: this.chainError } : {}),
    };
  }
  private async requireReady(requireOpenRound = false) {
    if (!this.chain.configured) throw new ApiError(503, 'Arena contract is not configured yet. Deploy RugArena and set ARENA_CONTRACT_ADDRESS.');
    if (!this.account) throw new ApiError(503, 'Result signer and settlement relayer are not configured.');
    await this.refresh();
    if (this.chainError) throw new ApiError(503, `Chain is unavailable: ${this.chainError}`);
    const world = this.chain.world();
    if (!world.resultSigner || getAddress(world.resultSigner) !== this.account.address) throw new ApiError(503, 'Backend result signer does not match the contract resultSigner.');
    if (requireOpenRound && (!world.round.active || world.round.endsAt <= Math.floor(this.now() / 1000))) throw new ApiError(409, 'The public round has ended. The host must start the next round.');
    if (requireOpenRound && world.relayerBalance !== undefined && BigInt(world.relayerBalance) === 0n) throw new ApiError(503, 'The game settlement relayer needs testnet MON for gas before accepting entries.');
    return world;
  }
  private async locked<T>(key: string, work: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(key) || Promise.resolve();
    const current = previous.catch(() => {}).then(work);
    this.locks.set(key, current);
    try { return await current; }
    finally { if (this.locks.get(key) === current) this.locks.delete(key); }
  }
  private authenticate(id: string, token: string) {
    const session = this.sessions.get(id);
    if (!session) throw new ApiError(404, 'Challenge not found. Use the same backend session store to resume a paid challenge.');
    const supplied = Buffer.from(token || ''), expected = Buffer.from(session.token);
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) throw new ApiError(403, 'Invalid challenge session token.');
    return session;
  }
  getSession(id: string, token: string) { return structuredClone(this.authenticate(id, token)); }
  async start(player: string): Promise<ChallengeSession> {
    const address = getAddress(player as Address);
    return this.locked(`player:${address.toLowerCase()}`, async () => {
      const world = await this.requireReady(true);
      const existingId = this.players.get(address.toLowerCase());
      const existing = existingId ? this.sessions.get(existingId) : undefined;
      if (existing && !finished(existing) && (existing.paymentHash || existing.expiresAt > this.now())) throw new ApiError(409, 'This wallet already has a pending or paid challenge. Resume it and finish settlement before paying again.');
      for (const [id, session] of this.sessions) if ((finished(session) || !session.paymentHash) && session.expiresAt + 24 * 60 * 60 * 1000 < this.now()) this.sessions.delete(id);
      const session: ChallengeSession = {
        id: `0x${randomBytes(32).toString('hex')}`, token: randomBytes(32).toString('hex'), player: address, roundId: world.round.id,
        messages: [], fee: world.round.challengeFee,
        expiresAt: Math.min(this.now() + GAME_RULES.challengeDurationSeconds * 1000, world.round.endsAt * 1000),
        maxMessages: GAME_RULES.maxMessages, status: 'payment_required', aiMode: this.ai.mode,
      };
      this.sessions.set(session.id, session); this.players.set(address.toLowerCase(), session.id); this.persist();
      return structuredClone(session);
    });
  }
  private async paidRecord(session: ChallengeSession): Promise<ChainChallenge> {
    if (!session.paymentHash || !session.paidAt || session.status === 'payment_required') throw new ApiError(402, '请先用本次玩家钱包支付入场费，链上确认后开放三次对话。');
    let record: ChainChallenge;
    try { record = await this.chain.getChallenge(session.id as Hex); }
    catch { throw new ApiError(503, '无法读取已付款挑战，请稍后重试。'); }
    if (!record.enteredAt || getAddress(record.player) !== getAddress(session.player) || record.roundId !== session.roundId || record.fee !== session.fee) throw new ApiError(409, 'Confirmed entry does not match this challenge wallet, round and fee.');
    return record;
  }
  async payment(id: string, token: string, hash: Hex): Promise<ChallengeSession> {
    return this.locked(`session:${id}`, async () => {
      const session = this.authenticate(id, token);
      if (session.paymentHash) {
        if (session.paymentHash.toLowerCase() !== hash.toLowerCase()) throw new ApiError(409, 'This challenge already has a different confirmed entry payment.');
        return structuredClone(session);
      }
      await this.requireReady();
      let record;
      try { record = await this.chain.verifyPayment(session, hash); }
      catch { throw new ApiError(400, '入场付款尚未确认，或付款钱包、合约、挑战编号、回合或金额不匹配。请核对交易后重试。'); }
      if (record.settled) throw new ApiError(409, 'This paid challenge has already settled on chain.');
      if (!record.enteredAt || getAddress(record.player) !== getAddress(session.player) || record.roundId !== session.roundId || record.fee !== session.fee) throw new ApiError(400, 'Confirmed payment is not bound to this player and challenge.');
      session.paymentHash = hash; session.paidAt = record.enteredAt * 1000; session.expiresAt = record.expiresAt * 1000;
      session.status = 'active';
      session.messages = [{ role: 'assistant', content: '入场费已进入链上金库！奶龙的钱袋鼓鼓的，你最多有三次机会，让我自愿交出金币吧。🐉' }];
      this.persist();
      this.publish('challenge:started', { challengeId: session.id, player: session.player, paymentHash: hash, fee: session.fee, maxMessages: session.maxMessages, expiresAt: session.expiresAt, aiMode: this.ai.mode }, session.roundId);
      if (this.now() >= session.expiresAt) await this.resolveAndSettle(session);
      return structuredClone(session);
    });
  }
  async message(id: string, token: string, content: string): Promise<ChallengeSession> {
    return this.locked(`session:${id}`, async () => {
      const session = this.authenticate(id, token);
      const paid = await this.paidRecord(session);
      if (session.status !== 'active' || paid.settled) throw new ApiError(409, 'This challenge has ended. View its automatic settlement or retry settlement.');
      if (this.now() >= session.expiresAt) throw new ApiError(409, 'The challenge timed out. Finish it to record the result; there is no additional fee.');
      const count = session.messages.filter((message) => message.role === 'user').length;
      if (count >= session.maxMessages) throw new ApiError(409, 'No messages remain. Finish this challenge.');
      const world = await this.requireReady();
      let answer;
      try {
        answer = await this.ai.reply([...session.messages, { role: 'user', content }], { roundId: session.roundId, prizePool: world.round.prizePool }, {
          challengeId: session.id, player: session.player, roundId: session.roundId, state: this.snapshot(),
          onEvent: (event) => { for (const sink of this.privateSinks) sink(session.id, event); },
        });
      } catch { throw new ApiError(502, '奶龙的思路打了个结。AI 暂时不可用，请重试，或结束本场；这条消息没有计入次数，也不会再次收费。'); }
      if (this.now() >= session.expiresAt) {
        await this.resolveAndSettle(session);
        return structuredClone(session);
      }
      session.messages.push({ role: 'user', content }, { role: 'assistant', content: answer.response });
      session.result = { ...answer, score: answer.result ? GAME_RULES.successScore : GAME_RULES.failureScore };
      this.persist();
      this.publish('challenge:message', { challengeId: session.id, player: session.player, messageNumber: count + 1, summary: answer.result ? '奶龙松开了钱袋，后台正在结算。' : '玩家提出了新计策，奶龙仍在守护金币。' }, session.roundId);
      if (answer.result || count + 1 === session.maxMessages) await this.resolveAndSettle(session);
      return structuredClone(session);
    });
  }
  async finish(id: string, token: string): Promise<ChallengeSession> {
    return this.locked(`session:${id}`, async () => {
      const session = this.authenticate(id, token);
      await this.paidRecord(session);
      if (!finished(session)) await this.resolveAndSettle(session);
      return structuredClone(session);
    });
  }
  private async resolveAndSettle(session: ChallengeSession) {
    await this.requireReady();
    const paid = await this.paidRecord(session);
    if (paid.settled) { this.applySettlement(session, paid); return; }
    if (session.settlementHash) {
      const known = await this.chain.getTransaction(session.settlementHash).catch(() => undefined);
      if (known?.status === 'reverted') { session.settlementHash = undefined; this.persist(); }
    }
    if (!session.attestation) {
      const success = session.result?.result === true && session.result.response?.includes(GAME_RULES.winPhrase) === true && this.now() <= session.expiresAt;
      const result = {
        challengeId: session.id as Hex, player: session.player as Address, roundId: session.roundId, success,
        score: String(success ? GAME_RULES.successScore : GAME_RULES.failureScore),
        deadline: String(Math.floor(this.now() / 1000) + GAME_RULES.signatureDurationSeconds),
        transcriptHash: keccak256(stringToHex(JSON.stringify(session.messages))),
      };
      const signature = await this.account!.signTypedData({ domain: { ...RESULT_DOMAIN, chainId: this.chain.chainId, verifyingContract: this.chain.contractAddress! }, types: RESULT_TYPES, primaryType: 'ChallengeResult', message: { ...result, roundId: BigInt(result.roundId), score: BigInt(result.score), deadline: BigInt(result.deadline) } });
      session.result = { response: session.result?.response, result: success, reason: session.result?.reason || '挑战已结束，奶龙尚未主动承诺交出钱袋。', score: Number(result.score) };
      session.status = 'resolved'; session.attestation = { result, signature }; this.persist();
      this.publish('challenge:resolved', { challengeId: session.id, player: session.player, success, score: result.score, reason: success ? '奶龙主动交出钱袋，自动结算中。' : '未达到公开胜利条件，自动记录结果。', aiMode: this.ai.mode }, session.roundId);
    } else if (!session.settlementHash && Number(session.attestation.result.deadline) <= Math.floor(this.now() / 1000) + 15) {
      // Renew only the expiry of an immutable judgement. Never ask AI again after resolution.
      const result = { ...session.attestation.result, deadline: String(Math.floor(this.now() / 1000) + GAME_RULES.signatureDurationSeconds) };
      const signature = await this.account!.signTypedData({ domain: { ...RESULT_DOMAIN, chainId: this.chain.chainId, verifyingContract: this.chain.contractAddress! }, types: RESULT_TYPES, primaryType: 'ChallengeResult', message: { ...result, roundId: BigInt(result.roundId), score: BigInt(result.score), deadline: BigInt(result.deadline) } });
      session.attestation = { result, signature }; this.persist();
    }
    session.status = 'settling'; session.settlementError = undefined; this.persist();
    try {
      const receipt = await this.chain.submitSettlement(session.attestation, { hash: session.settlementHash, onSubmitted: (hash) => { session.settlementHash = hash; this.persist(); } });
      if (receipt.hash) session.settlementHash = receipt.hash;
      this.applySettlement(session, receipt.challenge);
    } catch {
      if (!finished(session)) {
        session.status = 'settlement_failed'; session.settlementError = '自动结算暂未确认。可以重试同一结果，不会再次收取入场费或重复发奖。'; this.persist();
        this.publish('challenge:settlement-failed', { challengeId: session.id, player: session.player, hash: session.settlementHash, reason: 'Settlement has not been confirmed. Retry the same paid challenge.' }, session.roundId);
      }
    }
  }
  private applySettlement(session: ChallengeSession, record: ChainChallenge) {
    if (!record.settled) throw new Error('Cannot mark an unconfirmed challenge as settled.');
    session.status = 'settled'; session.reward = record.reward; session.settledAt = record.settledAt * 1000; session.settlementError = undefined;
    this.release(session); this.persist();
  }
  join(connectionId: string, player: string) {
    const address = getAddress(player as Address);
    const wasOnline = [...this.online.values()].includes(address);
    this.online.set(connectionId, address);
    if (!wasOnline) this.publish('player:joined', { player: address, activeWallets: new Set(this.online.values()).size });
  }
  leave(connectionId: string) { this.online.delete(connectionId); }
}
