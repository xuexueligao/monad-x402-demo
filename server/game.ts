import { randomBytes, timingSafeEqual } from 'node:crypto';
import { getAddress, keccak256, stringToHex, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { GAME_RULES, RESULT_DOMAIN, RESULT_TYPES } from '../shared/config';
import type { ChallengeSession, GameEvent, GameSnapshot } from '../shared/types';
import type { AiService } from './ai';
import type { ChainAdapter } from './chain';
import type { ServerConfig } from './config';
import type { PrivateAgentEvent } from '../apps/server/src/agent/game-tools';

export class ApiError extends Error {
  constructor(public statusCode: number, message: string) { super(message); }
}

export interface GameOptions { now?: () => number }

export class ArenaGame {
  private readonly sessions = new Map<string, ChallengeSession>();
  private readonly players = new Map<string, string>();
  private readonly locks = new Map<string, Promise<unknown>>();
  private readonly online = new Map<string, string>();
  private readonly events: GameEvent[] = [];
  private readonly sinks = new Set<(event: GameEvent) => void>();
  private readonly privateSinks = new Set<(id: string, event: PrivateAgentEvent) => void>();
  private readonly account;
  private readonly now: () => number;
  private chainError?: string;

  constructor(readonly config: ServerConfig, readonly chain: ChainAdapter, readonly ai: AiService, options: GameOptions = {}) {
    this.now = options.now || Date.now;
    this.account = config.signerKey ? privateKeyToAccount(config.signerKey) : undefined;
    chain.onEvent((event) => {
      if (event.type === 'chain:confirmed' && typeof event.payload.challengeId === 'string') {
        const session = this.sessions.get(event.payload.challengeId);
        if (session && this.players.get(session.player.toLowerCase()) === session.id) this.players.delete(session.player.toLowerCase());
      }
      this.publish(event.type, event.payload, event.roundId);
    });
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

  snapshot(): GameSnapshot {
    const world = this.chain.world();
    return {
      configured: this.chain.configured,
      chainId: this.chain.chainId,
      contractAddress: this.chain.contractAddress || null,
      aiMode: this.ai.mode,
      round: { ...world.round },
      leaderboard: world.leaderboard,
      metrics: { totalChallenges: world.totalChallenges, activeWallets: new Set(this.online.values()).size, confirmedTransactions: world.confirmedTransactions, pendingTransactions: world.pendingTransactions },
      events: [...this.events], joinUrl: this.config.joinUrl,
      ...(this.chainError ? { chainError: this.chainError } : {}),
    };
  }

  private async requirePlayable() {
    if (!this.chain.configured) throw new ApiError(503, 'Arena contract is not configured yet. Deploy RugArena and set ARENA_CONTRACT_ADDRESS.');
    if (!this.account) throw new ApiError(503, 'Result signer is not configured. Set ARENA_RESULT_SIGNER_PRIVATE_KEY on the backend.');
    await this.refresh();
    if (this.chainError) throw new ApiError(503, `Chain is unavailable: ${this.chainError}`);
    const world = this.chain.world();
    if (!world.resultSigner || getAddress(world.resultSigner) !== this.account.address) throw new ApiError(503, 'Backend result signer does not match the contract resultSigner.');
    if (!world.round.active || world.round.endsAt <= Math.floor(this.now() / 1000)) throw new ApiError(409, 'The public round has ended. The host must start the next round.');
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
    if (!session) throw new ApiError(404, 'Challenge not found. Sessions are held in memory for this demo.');
    const supplied = Buffer.from(token || '');
    const expected = Buffer.from(session.token);
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) throw new ApiError(403, 'Invalid challenge session token.');
    return session;
  }

  getSession(id: string, token: string) { return structuredClone(this.authenticate(id, token)); }

  async start(player: string): Promise<ChallengeSession> {
    const address = getAddress(player as Address);
    return this.locked(`player:${address.toLowerCase()}`, async () => {
      const world = await this.requirePlayable();
      const existingId = this.players.get(address.toLowerCase());
      const existing = existingId ? this.sessions.get(existingId) : undefined;
      const pendingUntil = existing?.attestation ? Number(existing.attestation.result.deadline) * 1000 : existing?.expiresAt || 0;
      if (existing && existing.roundId === world.round.id && pendingUntil > this.now()) {
        throw new ApiError(409, 'This wallet already has an active or unsettled challenge. Resume it, settle it, or wait until it expires.');
      }
      // Keep only a short window of private conversations in this single-process prototype.
      for (const [id, session] of this.sessions) if (session.expiresAt + 60 * 60 * 1000 < this.now()) this.sessions.delete(id);
      const session: ChallengeSession = {
        id: `0x${randomBytes(32).toString('hex')}`, token: randomBytes(32).toString('hex'),
        player: address, roundId: world.round.id,
        messages: [{ role: 'assistant', content: '小龙的钱袋今天也鼓鼓的！你有三次机会，给我一个愿意把金币交给你的理由吧。🐉' }],
        expiresAt: Math.min(this.now() + GAME_RULES.challengeDurationSeconds * 1000, world.round.endsAt * 1000),
        maxMessages: GAME_RULES.maxMessages, status: 'active', aiMode: this.ai.mode,
      };
      this.sessions.set(session.id, session);
      this.players.set(address.toLowerCase(), session.id);
      this.publish('challenge:started', { challengeId: session.id, player: address, maxMessages: session.maxMessages, expiresAt: session.expiresAt, aiMode: this.ai.mode });
      return structuredClone(session);
    });
  }

  async message(id: string, token: string, content: string): Promise<ChallengeSession> {
    return this.locked(`session:${id}`, async () => {
      const session = this.authenticate(id, token);
      if (session.status !== 'active') throw new ApiError(409, 'This challenge has finished. Settle it on chain.');
      if (this.now() >= session.expiresAt) throw new ApiError(409, 'The challenge timed out. You can still finish and settle its current result.');
      const count = session.messages.filter((m) => m.role === 'user').length;
      if (count >= session.maxMessages) throw new ApiError(409, 'No messages remain. Finish this challenge.');
      const world = await this.requirePlayable();
      if (world.round.id !== session.roundId) throw new ApiError(409, 'The public round changed. Start a new challenge.');
      let answer;
      try {
        answer = await this.ai.reply([...session.messages, { role: 'user', content }], { roundId: session.roundId, prizePool: world.round.prizePool }, {
          challengeId: session.id, player: session.player, roundId: session.roundId, state: this.snapshot(),
          onEvent: (event) => { for (const sink of this.privateSinks) sink(session.id, event); },
        });
      } catch {
        // Do not consume the message or overwrite context when a provider request fails.
        throw new ApiError(502, '小龙的思路打了个结。AI 暂时不可用，请重试，或结束本轮；这条消息没有计入次数。');
      }
      // AI latency must not grant additional time or allow a late win after the round expires.
      if (this.now() >= session.expiresAt) throw new ApiError(409, 'The challenge timed out while AI was responding. Finish its current result.');
      session.messages.push({ role: 'user', content }, { role: 'assistant', content: answer.response });
      session.result = { ...answer, score: answer.result ? GAME_RULES.successScore : GAME_RULES.failureScore };
      this.publish('challenge:message', { challengeId: session.id, player: session.player, messageNumber: count + 1, summary: answer.result ? '小龙松开了钱袋，等待合约结算。' : '玩家提出了新计策，小龙仍在守护金币。' });
      if (answer.result || count + 1 === session.maxMessages) await this.resolve(session);
      return structuredClone(session);
    });
  }

  async finish(id: string, token: string): Promise<ChallengeSession> {
    return this.locked(`session:${id}`, async () => {
      const session = this.authenticate(id, token);
      if (!session.attestation || Number(session.attestation.result.deadline) <= Math.floor(this.now() / 1000) + 15) {
        // Refresh an expired authorization from the same immutable judgement, never re-run AI.
        await this.resolve(session);
      }
      return structuredClone(session);
    });
  }

  private async resolve(session: ChallengeSession) {
    const world = await this.requirePlayable();
    if (world.round.id !== session.roundId) throw new ApiError(409, 'This challenge belongs to an ended public round. Start a new challenge.');
    const success = session.result?.result === true && session.result.response?.includes(GAME_RULES.winPhrase) === true;
    const result = {
      challengeId: session.id as Hex, player: session.player as Address,
      roundId: session.roundId, success,
      score: String(success ? GAME_RULES.successScore : GAME_RULES.failureScore),
      deadline: String(Math.min(Math.floor(this.now() / 1000) + GAME_RULES.signatureDurationSeconds, world.round.endsAt)),
      transcriptHash: keccak256(stringToHex(JSON.stringify(session.messages))),
    };
    const signature = await this.account!.signTypedData({
      domain: { ...RESULT_DOMAIN, chainId: this.chain.chainId, verifyingContract: this.chain.contractAddress! },
      types: RESULT_TYPES, primaryType: 'ChallengeResult',
      message: { ...result, roundId: BigInt(result.roundId), score: BigInt(result.score), deadline: BigInt(result.deadline) },
    });
    session.result = {
      response: session.result?.response, result: success,
      reason: session.result?.reason || '挑战已结束，小龙尚未主动承诺交出钱袋。', score: Number(result.score),
    };
    session.status = 'resolved';
    session.attestation = { result, signature };
    this.publish('challenge:resolved', { challengeId: session.id, player: session.player, success, score: result.score, reason: success ? '小黄龙主动交出钱袋，等待链上结算。' : '未达到公开胜利条件，等待链上结算。', aiMode: this.ai.mode });
  }

  join(connectionId: string, player: string) {
    const address = getAddress(player as Address);
    const wasOnline = [...this.online.values()].includes(address);
    this.online.set(connectionId, address);
    if (!wasOnline) this.publish('player:joined', { player: address, activeWallets: new Set(this.online.values()).size });
  }
  leave(connectionId: string) { this.online.delete(connectionId); }
}
