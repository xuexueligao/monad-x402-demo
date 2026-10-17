'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useAccount, usePublicClient, useSignMessage, useWriteContract } from 'wagmi';
import { decodeEventLog, type Abi, type Address, type Hash, type TransactionReceipt } from 'viem';
import arenaAbi from '../../contracts/abi/RugArena.json';
import { GAME_RULES } from '../../shared/config';
import { getRecoveryMessage } from '../../shared/session-recovery';
import { api, ApiError } from './api';
import { useArena } from './arena-context';
import { monad } from './wagmi';
import type { ChallengeSession, GameSnapshot } from './types';

export type ChallengePhase = 'idle' | 'starting' | 'payment_required' | 'signing' | 'payment_pending' | 'payment_verifying' | 'payment_failed' | 'active' | 'thinking' | 'resolved' | 'settling' | 'confirmed' | 'settlement_failed' | 'recovery_required' | 'recovering';
type ChainRound = { id: bigint; challengeFee: bigint; endsAt: bigint; active: boolean };
type ChainChallenge = { player: Address; roundId: bigint; fee: bigint; success: boolean; score: bigint; reward: bigint; enteredAt: bigint; settled: boolean };
type SavedChallenge = { session?: ChallengeSession; paymentHash?: Hash; roundHash?: Hash; recoveryRequired?: boolean };
type RecoveryTarget = { challengeId: string; player: string; paymentHash?: string };
const abi = arenaAbi as Abi;
const validHash = (value: unknown): value is Hash => typeof value === 'string' && /^0x[\da-f]{64}$/i.test(value);
const isMissingSession = (cause: unknown) => cause instanceof ApiError && cause.status === 404 || /challenge not found/i.test(cause instanceof Error ? cause.message : String(cause));
const cache = (key: string | null, values: SavedChallenge) => {
  if (!key) return;
  try { localStorage.setItem(key, JSON.stringify(values)); } catch { /* Memory state still protects an in-flight payment. */ }
};
const phaseFor = (session: ChallengeSession): ChallengePhase => {
  if (session.status === 'payment_required') return session.paymentHash ? 'payment_pending' : 'payment_required';
  if (session.status === 'active') return 'active';
  if (session.status === 'settlement_failed') return 'settlement_failed';
  // Even a server-confirmed result is checked against the actual receipt below.
  return session.settlementHash || session.status === 'settling' || session.status === 'settled' ? 'settling' : 'resolved';
};
const explain = (cause: unknown) => {
  const message = cause instanceof Error ? cause.message : String(cause);
  if (isMissingSession(cause)) return '服务重启后需要恢复本场挑战，已付费用会保留。';
  if (/reject|denied|4001/i.test(message)) return '已取消钱包操作，尚未支付挑战费。可以再次开始。';
  if (/insufficient funds|exceeds the balance/i.test(message)) return '你的测试 MON 余额不足，需要本场挑战费和少量 Gas。';
  if (/RoundClosed|WrongRound|RoundNotActive|RoundMismatch|round.*(ended|active)/i.test(message)) return '公共回合已结束，请开启新回合后再支付。';
  if (/ChallengeExpired|challenge.*expired/i.test(message)) return '本场聊天时间已结束，可以结束对话并结算。';
  return message.split('\n')[0].slice(0, 190);
};
function findEvent(receipt: TransactionReceipt, contract: string, name: string, matches: (args: Record<string, unknown>) => boolean) {
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== contract.toLowerCase()) continue;
    try {
      const event = decodeEventLog({ abi, data: log.data, topics: log.topics }) as unknown as { eventName: string; args: Record<string, unknown> };
      if (event.eventName === name && matches(event.args)) return event.args;
    } catch { /* Only this contract's expected event confirms an action. */ }
  }
}

/** One wallet payment opens one isolated challenge. Only the backend relays its result. */
export function useChallenge() {
  const { address, chainId } = useAccount();
  const { state, refresh, reportTransaction } = useArena();
  const client = usePublicClient({ chainId: monad.id });
  const { writeContractAsync } = useWriteContract();
  const { signMessageAsync } = useSignMessage();
  const [session, setSession] = useState<ChallengeSession | null>(null);
  const [phase, setPhase] = useState<ChallengePhase>('idle');
  const [error, setError] = useState<string | null>(null);
  const [paymentHash, setPaymentHash] = useState<Hash | null>(null);
  const [roundHash, setRoundHash] = useState<Hash | null>(null);
  const [actualReward, setActualReward] = useState('0');
  const [confirmedSuccess, setConfirmedSuccess] = useState(false);
  const [hydratedKey, setHydratedKey] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  const busy = useRef(false);
  const operation = useRef(0);
  const storageKey = address && state?.contractAddress ? `rug-arena:prepaid-v1:${monad.id}:${state.contractAddress}:${address.toLowerCase()}` : null;
  const scope = useRef(storageKey);
  scope.current = storageKey;
  const activeSession = useRef(session);
  activeSession.current = session;
  const savedPaymentHash = useRef(paymentHash);
  savedPaymentHash.current = paymentHash;
  const recoveryRequired = useRef(false);
  const recoveryLock = useRef<{ key: string | null; promise: Promise<ChallengeSession | null> } | null>(null);
  const autoRecoveryAttempts = useRef(new Set<string>());
  const recoveryEnvironment = useRef({ address, chainId, state, signMessageAsync });
  recoveryEnvironment.current = { address, chainId, state, signMessageAsync };
  const confirmedId = useRef<string | null>(null);
  const applySession = useCallback((next: ChallengeSession) => {
    activeSession.current = next;
    setSession(next);
    if (validHash(next.paymentHash)) { savedPaymentHash.current = next.paymentHash; setPaymentHash(next.paymentHash); }
    if (confirmedId.current !== next.id) setPhase(current => next.status === 'payment_required' && savedPaymentHash.current ? current === 'payment_verifying' ? current : 'payment_pending' : phaseFor(next));
  }, []);
  const recoverSession = useCallback((target: RecoveryTarget, automatic = false): Promise<ChallengeSession | null> => {
    const key = scope.current;
    if (recoveryLock.current?.key === key) return recoveryLock.current.promise;
    const current = activeSession.current?.id.toLowerCase() === target.challengeId.toLowerCase() ? activeSession.current : null;
    const checkpoint = current?.recoveryCheckpoint;
    const hash = validHash(target.paymentHash) ? target.paymentHash : validHash(current?.paymentHash) ? current.paymentHash : current && validHash(savedPaymentHash.current) ? savedPaymentHash.current : null;
    const attempt = `${target.challengeId}:${checkpoint || ''}`;
    recoveryRequired.current = true;
    if (automatic && (!checkpoint || autoRecoveryAttempts.current.has(attempt))) {
      setPhase('recovery_required');
      setError(checkpoint ? '自动恢复暂未完成，请重试恢复本场挑战。' : '本场已付费记录仍然保留，请用原付款钱包恢复挑战。');
      return Promise.resolve(null);
    }
    if (automatic) autoRecoveryAttempts.current.add(attempt);
    const version = operation.current;
    const stillCurrent = () => scope.current === key && operation.current === version;
    setPhase('recovering'); setError(null);
    const lock = { key, promise: Promise.resolve<ChallengeSession | null>(null) };
    recoveryLock.current = lock;
    lock.promise = (async () => {
      try {
        let body: Record<string, unknown>;
        if (checkpoint) body = { checkpoint, ...(hash ? { paymentHash: hash } : {}) };
        else {
          const environment = recoveryEnvironment.current;
          if (!environment.address || environment.address.toLowerCase() !== target.player.toLowerCase()) throw new Error('请连接本场原付款钱包后恢复。');
          if (environment.chainId !== monad.id) throw new Error('请先将原付款钱包切换到 Monad Testnet。');
          if (!environment.state?.configured || !environment.state.contractAddress || environment.state.chainId !== monad.id) throw new Error('竞技场合约暂不可用，请稍后重试恢复。');
          if (!hash) throw new Error('需要本场原付款交易哈希才能核验，请从原付款钱包的交易记录中复制；不要再次付款。');
          const issuedAt = Date.now();
          const signature = await environment.signMessageAsync({ account: target.player as Address, message: getRecoveryMessage({ challengeId: target.challengeId, player: target.player, paymentHash: hash, chainId: monad.id, contractAddress: environment.state.contractAddress, issuedAt }) });
          if (!stillCurrent()) return null;
          const latest = recoveryEnvironment.current;
          if (latest.address?.toLowerCase() !== target.player.toLowerCase() || latest.chainId !== monad.id) throw new Error('钱包或网络已变化，请切回原付款钱包后重试恢复。');
          body = { challengeId: target.challengeId, player: target.player, paymentHash: hash, issuedAt, signature };
        }
        const next = await api<ChallengeSession>('/api/challenges/recover', { method: 'POST', body: JSON.stringify(body) });
        if (!stillCurrent()) return null;
        recoveryRequired.current = false;
        applySession(next); setError(null);
        // Save the replacement token and signed checkpoint before any reload can interrupt React.
        cache(key, { session: next, paymentHash: validHash(next.paymentHash) ? next.paymentHash : hash || undefined });
        return next;
      } catch (cause) {
        if (stillCurrent()) {
          if (confirmedId.current === target.challengeId) { recoveryRequired.current = false; return null; }
          setPhase('recovery_required');
          const message = cause instanceof Error ? cause.message : String(cause);
          setError(/reject|denied|4001/i.test(message) ? '已取消身份签名，可随时重试恢复；不会再次付款。' : /[\u3400-\u9fff]/.test(message) ? message.split('\n')[0].slice(0, 190) : '恢复暂未完成，请稍后重试；已付款记录会保留。');
        }
        return null;
      } finally { if (recoveryLock.current === lock) recoveryLock.current = null; }
    })();
    return lock.promise;
  }, [applySession]);
  const handleMissingSession = useCallback((requested: ChallengeSession, hash?: Hash | null) => {
    const latest = activeSession.current;
    // A late response from the old token must not invalidate an already recovered session.
    if (!latest || latest.id !== requested.id || latest.token !== requested.token || confirmedId.current === requested.id) return Promise.resolve(null);
    return recoverSession({ challengeId: latest.id, player: latest.player, paymentHash: hash || latest.paymentHash }, true);
  }, [recoverSession]);
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, []);
  useEffect(() => {
    const version = ++operation.current;
    busy.current = false; confirmedId.current = null;
    activeSession.current = null; savedPaymentHash.current = null;
    recoveryRequired.current = false; recoveryLock.current = null; autoRecoveryAttempts.current.clear();
    setSession(null); setPaymentHash(null); setRoundHash(null); setActualReward('0'); setConfirmedSuccess(false); setError(null); setPhase('idle');
    if (storageKey) {
      try {
        const raw = localStorage.getItem(storageKey);
        const saved = raw ? JSON.parse(raw) as SavedChallenge : null;
        const restored = saved?.session && saved.session.player.toLowerCase() === address?.toLowerCase() ? saved.session : null;
        if (restored) {
          const hash = validHash(saved?.paymentHash) ? saved.paymentHash : validHash(restored.paymentHash) ? restored.paymentHash : null;
          activeSession.current = restored; savedPaymentHash.current = hash; recoveryRequired.current = !!saved?.recoveryRequired;
          setSession(restored); setPaymentHash(hash); setPhase(saved?.recoveryRequired ? 'recovery_required' : hash && restored.status === 'payment_required' ? 'payment_pending' : phaseFor(restored));
          void api<ChallengeSession>(`/api/game/challenges/${restored.id}`, { headers: { 'x-challenge-token': restored.token } }).then(next => {
            if (scope.current === storageKey && operation.current === version && !recoveryLock.current) { recoveryRequired.current = false; applySession(next); }
          }).catch(async cause => {
            if (scope.current !== storageKey || operation.current !== version) return;
            if (isMissingSession(cause)) { await handleMissingSession(restored, hash); return; }
            // A paid or pending challenge is retained across a transient server/RPC outage.
            setError(explain(cause));
          });
        }
        if (validHash(saved?.roundHash)) setRoundHash(saved.roundHash);
      } catch { /* An unavailable local cache never blocks wallet connection. */ }
    }
    setHydratedKey(storageKey);
  }, [storageKey, address, applySession, handleMissingSession]);
  useEffect(() => {
    if (!storageKey || hydratedKey !== storageKey || (session && session.player.toLowerCase() !== address?.toLowerCase())) return;
    cache(storageKey, { session: session || undefined, paymentHash: paymentHash || undefined, roundHash: roundHash || undefined, recoveryRequired: recoveryRequired.current && phase !== 'confirmed' || undefined });
  }, [storageKey, hydratedKey, session, paymentHash, roundHash, address, phase]);

  // The receipt binds this payment to the exact wallet, challenge, and public round.
  useEffect(() => {
    if (!session || session.paidAt || !paymentHash || !client || !state?.contractAddress || hydratedKey !== storageKey || recoveryRequired.current) return;
    let cancelled = false, checking = false;
    const current = session, key = storageKey;
    const check = async () => {
      if (checking) return;
      checking = true;
      try {
        const receipt = await client.getTransactionReceipt({ hash: paymentHash });
        if (cancelled || scope.current !== key || recoveryRequired.current) return;
        const entered = findEvent(receipt, state.contractAddress!, 'ChallengeEntered', args =>
          String(args.challengeId).toLowerCase() === current.id.toLowerCase() && String(args.player).toLowerCase() === current.player.toLowerCase() && String(args.roundId) === current.roundId && String(args.fee) === current.fee);
        if (receipt.status === 'reverted' || !entered) {
          setPaymentHash(null); setPhase('payment_failed');
          setError(receipt.status === 'reverted' ? '付款交易已回滚，合约没有收取挑战费，可以重试。' : '这笔交易没有支付当前挑战，请检查钱包交易。');
          return;
        }
        setPhase('payment_verifying');
        const next = await api<ChallengeSession>(`/api/challenges/${current.id}/payment`, { method: 'POST', body: JSON.stringify({ token: current.token, hash: paymentHash }) });
        if (cancelled || scope.current !== key || activeSession.current?.token !== current.token) return;
        applySession(next); setError(null); void reportTransaction(paymentHash, current.id); void refresh();
      } catch (cause) {
        if (!cancelled && scope.current === key && isMissingSession(cause)) { await handleMissingSession(current, paymentHash); return; }
        // A missing receipt remains pending. Backend verification errors retry without another payment.
        if (!cancelled && scope.current === key && !/receipt.*not found|could not be found/i.test(String(cause))) setError(explain(cause));
      } finally { checking = false; }
    };
    void check(); const timer = setInterval(() => void check(), 2500);
    return () => { cancelled = true; clearInterval(timer); };
  }, [session?.id, session?.token, session?.paidAt, session?.fee, paymentHash, client, state?.contractAddress, storageKey, hydratedKey, phase === 'recovery_required' || phase === 'recovering', applySession, handleMissingSession, reportTransaction, refresh]);

  // Results and relay hashes survive page reloads; the player never signs a settlement transaction.
  useEffect(() => {
    if (!session || !session.paidAt || phase === 'confirmed' || hydratedKey !== storageKey || recoveryRequired.current) return;
    let cancelled = false, checking = false;
    const id = session.id, token = session.token, key = storageKey;
    const check = async () => {
      if (checking || busy.current || recoveryRequired.current || confirmedId.current === id) return;
      checking = true;
      const version = operation.current;
      try {
        const next = await api<ChallengeSession>(`/api/game/challenges/${id}`, { headers: { 'x-challenge-token': token } });
        if (!cancelled && scope.current === key && operation.current === version && !busy.current && !recoveryRequired.current && activeSession.current?.id === id && activeSession.current.token === token) applySession(next);
      } catch (cause) {
        if (!cancelled && scope.current === key && operation.current === version && isMissingSession(cause)) await handleMissingSession(session);
        // Other transient failures reconnect without disturbing the current conversation.
      }
      finally { checking = false; }
    };
    const timer = setInterval(() => void check(), 2500);
    return () => { cancelled = true; clearInterval(timer); };
  }, [session?.id, session?.token, session?.paidAt, phase === 'confirmed', phase === 'recovery_required' || phase === 'recovering', storageKey, hydratedKey, applySession, handleMissingSession]);

  useEffect(() => {
    const hash = session?.settlementHash;
    if (!session || !validHash(hash) || !client || !state?.contractAddress || hydratedKey !== storageKey || confirmedId.current === session.id) return;
    let cancelled = false, checking = false;
    const current = session, key = storageKey;
    const matches = (args: Record<string, unknown>) => String(args.challengeId).toLowerCase() === current.id.toLowerCase() && String(args.player).toLowerCase() === current.player.toLowerCase() && String(args.roundId) === current.roundId;
    const check = async () => {
      if (checking) return;
      checking = true;
      try {
        const receipt = await client.getTransactionReceipt({ hash });
        if (cancelled || scope.current !== key) return;
        const settled = findEvent(receipt, state.contractAddress!, 'ChallengeSettled', matches);
        if (receipt.status !== 'success' || !settled) {
          if (!recoveryRequired.current) { setPhase('settlement_failed'); setError('结算交易未成功，可以重试后台结算；不会再次收取挑战费。'); } return;
        }
        const reward = String(settled.reward || '0');
        const paid = findEvent(receipt, state.contractAddress!, 'RewardPaid', args => matches(args) && String(args.amount) === reward);
        if (settled.success && BigInt(reward) > 0n && !paid) {
          if (!recoveryRequired.current) { setPhase('settlement_failed'); setError('尚未找到向本次付款钱包发奖的记录，请重试查询。'); } return;
        }
        confirmedId.current = current.id; recoveryRequired.current = false; setActualReward(reward); setConfirmedSuccess(Boolean(settled.success)); setPhase('confirmed'); setError(null);
        void reportTransaction(hash, current.id); void refresh();
      } catch { /* The relay remains pending until a genuine receipt is available. */ }
      finally { checking = false; }
    };
    void check(); const timer = setInterval(() => void check(), 2000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [session?.id, session?.settlementHash, client, state?.contractAddress, storageKey, hydratedKey, refresh, reportTransaction]);

  // A restored chain result may predate the available event/transaction history.
  useEffect(() => {
    if (!session || session.status !== 'settled' || session.settlementHash || !client || !state?.contractAddress || hydratedKey !== storageKey || confirmedId.current === session.id) return;
    let cancelled = false, checking = false;
    const current = session, key = storageKey;
    const check = async () => {
      if (checking) return;
      checking = true;
      try {
        const record = await client.readContract({ address: state.contractAddress as Address, abi, functionName: 'getChallenge', args: [current.id as Hash] }) as ChainChallenge;
        if (cancelled || scope.current !== key || activeSession.current?.id !== current.id) return;
        if (!record.settled) return;
        if (record.enteredAt <= 0n || record.player.toLowerCase() !== current.player.toLowerCase() || String(record.roundId) !== current.roundId || String(record.fee) !== current.fee || current.result && (record.success !== current.result.result || String(record.score) !== String(current.result.score)) || current.reward !== undefined && String(record.reward) !== current.reward) {
          setPhase('settlement_failed'); setError('链上结算记录与本场信息不一致，请重试查询；不会再次收费。'); return;
        }
        confirmedId.current = current.id; recoveryRequired.current = false;
        setActualReward(String(record.reward)); setConfirmedSuccess(record.success); setPhase('confirmed'); setError(null);
        void refresh();
      } catch { /* Keep the saved result until this exact on-chain record can be verified. */ }
      finally { checking = false; }
    };
    void check(); const timer = setInterval(() => void check(), 2500);
    return () => { cancelled = true; clearInterval(timer); };
  }, [session?.id, session?.status, session?.settlementHash, session?.player, session?.roundId, session?.fee, session?.reward, session?.result, client, state?.contractAddress, storageKey, hydratedKey, refresh]);

  useEffect(() => {
    if (!roundHash || !client || !state?.contractAddress || hydratedKey !== storageKey) return;
    let cancelled = false, checking = false;
    const check = async () => {
      if (checking) return;
      checking = true;
      try {
        const receipt = await client.getTransactionReceipt({ hash: roundHash });
        if (cancelled) return;
        const event = findEvent(receipt, state.contractAddress!, 'GameRoundStarted', () => true);
        if (receipt.status !== 'success' || !event) setError('新回合交易未成功，可以重试。');
        else { setError(null); void reportTransaction(roundHash); void refresh(); }
        setRoundHash(null);
      } catch { /* Keep the submitted round transaction pending. */ }
      finally { checking = false; }
    };
    void check(); const timer = setInterval(() => void check(), 2000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [roundHash, client, state?.contractAddress, storageKey, hydratedKey, reportTransaction, refresh]);

  const checkReady = (snapshot: GameSnapshot | null = state) => {
    if (!address) throw new Error('先连接你自己的 Monad Testnet 钱包。');
    if (chainId !== monad.id) throw new Error('请先将钱包切换到 Monad Testnet。');
    if (!snapshot?.configured || !snapshot.contractAddress) throw new Error('竞技场合约连接暂不可用。');
    if (snapshot.chainId !== monad.id) throw new Error('当前服务未连接 Monad Testnet。');
    return snapshot;
  };
  const begin = () => {
    const version = ++operation.current, key = storageKey;
    busy.current = true;
    return { key, current: () => scope.current === key && operation.current === version,
      end: () => { if (scope.current === key && operation.current === version) busy.current = false; } };
  };
  const blocked = () => busy.current || recoveryRequired.current || !!roundHash || (!!paymentHash && !session?.paidAt) || ['payment_pending', 'payment_verifying', 'settling', 'recovering', 'recovery_required'].includes(phase);
  const pay = async (current: ChallengeSession, snapshot: GameSnapshot, task: ReturnType<typeof begin>) => {
    if (!client) throw new Error('测试网 RPC 暂不可用，请稍后再试。');
    if (current.player.toLowerCase() !== address?.toLowerCase()) throw new Error('请切回本场挑战的钱包。');
    const round = await client.readContract({ address: snapshot.contractAddress as Address, abi, functionName: 'getCurrentRound' }) as ChainRound;
    if (!task.current()) return;
    if (!round.active || Number(round.endsAt) * 1000 <= Date.now() || String(round.id) !== current.roundId) throw new Error('公共回合已结束，请开启新回合后再支付。');
    if (round.challengeFee.toString() !== current.fee) throw new Error('挑战费用已更新，请重新开启本场。');
    setPhase('signing');
    const hash = await writeContractAsync({ account: current.player as Address, address: snapshot.contractAddress as Address, abi, functionName: 'enterChallenge', args: [current.id as Hash, BigInt(current.roundId)], value: round.challengeFee, chainId: monad.id });
    // Write before React renders so reloading cannot offer a second payment.
    cache(task.key, { session: current, paymentHash: hash }); void reportTransaction(hash, current.id);
    if (!task.current()) return;
    setPaymentHash(hash); setPhase('payment_pending');
  };
  const start = async () => {
    if (blocked() || (session && session.status !== 'payment_required')) return;
    const task = begin(); setError(null); setPhase('starting');
    try {
      const snapshot = checkReady(await refresh()); if (!task.current()) return;
      const next = session || await api<ChallengeSession>('/api/challenges/start', { method: 'POST', body: JSON.stringify({ player: address }) });
      if (!task.current()) return;
      setSession(next); cache(task.key, { session: next });
      await pay(next, snapshot, task);
    } catch (cause) { if (task.current()) { setError(explain(cause)); setPhase(activeSession.current ? 'payment_required' : 'idle'); } }
    finally { task.end(); }
  };
  const finishSession = (current: ChallengeSession) => api<ChallengeSession>(`/api/challenges/${current.id}/finish`, { method: 'POST', body: JSON.stringify({ token: current.token }) });
  const send = async (message: string) => {
    if (!session?.paidAt || blocked() || phase !== 'active' || !message.trim()) return false;
    const task = begin(); setError(null); setPhase('thinking');
    try {
      let next = await api<ChallengeSession>(`/api/challenges/${session.id}/message`, { method: 'POST', body: JSON.stringify({ token: session.token, message: message.trim() }) });
      if (!task.current()) return false;
      // The final message snapshot must survive a restart between reply and automatic finish.
      activeSession.current = next; setSession(next);
      cache(task.key, { session: next, paymentHash: validHash(next.paymentHash) ? next.paymentHash : paymentHash || undefined, roundHash: roundHash || undefined });
      if (next.status === 'active' && (next.result?.result || next.messages.filter(item => item.role === 'user').length >= next.maxMessages)) next = await finishSession(next);
      if (task.current()) { applySession(next); return true; }
      return false;
    } catch (cause) {
      if (task.current()) {
        if (isMissingSession(cause)) await handleMissingSession(activeSession.current || session);
        else { setError(explain(cause)); setPhase(phaseFor(activeSession.current || session)); }
      }
      return false;
    }
    finally { task.end(); }
  };
  const finish = async () => {
    if (!session?.paidAt || blocked() || phase === 'confirmed') return;
    const task = begin(); setError(null); setPhase(session.result ? 'settling' : 'thinking');
    try { const next = await finishSession(session); if (task.current()) applySession(next); }
    catch (cause) {
      if (task.current()) {
        if (isMissingSession(cause)) await handleMissingSession(session);
        else { setError(explain(cause)); setPhase(session.result ? 'settlement_failed' : 'active'); }
      }
    }
    finally { task.end(); }
  };
  const nextRound = async () => {
    if (blocked() || !client) return;
    const task = begin(); setError(null);
    try {
      const snapshot = checkReady(await refresh()); if (!task.current()) return;
      const round = await client.readContract({ address: snapshot.contractAddress as Address, abi, functionName: 'getCurrentRound' }) as ChainRound;
      if (!task.current()) return;
      if (round.active && Number(round.endsAt) * 1000 > Date.now()) { await refresh(); return; }
      const hash = await writeContractAsync({ address: snapshot.contractAddress as Address, abi, functionName: 'startGameRound', chainId: monad.id });
      cache(task.key, { session: session || undefined, paymentHash: paymentHash || undefined, roundHash: hash }); void reportTransaction(hash);
      if (task.current()) setRoundHash(hash);
    } catch (cause) { if (task.current()) setError(explain(cause)); }
    finally { task.end(); }
  };
  const reset = () => {
    if (busy.current || recoveryRequired.current && phase !== 'confirmed' || roundHash || (session && session.paidAt && phase !== 'confirmed') || paymentHash && !['confirmed', 'payment_failed'].includes(phase)) return;
    operation.current += 1; confirmedId.current = null;
    recoveryRequired.current = false; activeSession.current = null; savedPaymentHash.current = null;
    cache(storageKey, {});
    setSession(null); setPaymentHash(null); setPhase('idle'); setError(null); setActualReward('0'); setConfirmedSuccess(false);
  };
  const recover = async (target?: RecoveryTarget) => {
    if (busy.current || roundHash) return;
    const current = activeSession.current;
    const requested = target || (current ? { challengeId: current.id, player: current.player, paymentHash: paymentHash || current.paymentHash } : null);
    if (!requested) return;
    if (current && current.id.toLowerCase() !== requested.challengeId.toLowerCase() && phase !== 'confirmed' && (current.paidAt || paymentHash)) {
      setError('请先恢复或完成当前已付款挑战，付款记录会继续保留。'); return;
    }
    await recoverSession(requested);
  };
  const visible = hydratedKey === storageKey;
  const used = session?.messages.filter(item => item.role === 'user').length || 0;
  return { session: visible ? session : null, messages: visible ? session?.messages || [] : [], phase: visible ? phase : 'idle', error: visible ? error : null,
    paymentHash: visible ? paymentHash : null, txHash: visible ? session?.settlementHash || null : null,
    actualReward: visible ? actualReward : '0', confirmedSuccess: visible && confirmedSuccess,
    pendingActionHash: visible ? roundHash : null, roundPending: !!roundHash,
    remaining: Math.max(0, (session?.maxMessages || GAME_RULES.maxMessages) - used),
    secondsLeft: session?.paidAt ? Math.max(0, Math.ceil((session.expiresAt * (session.expiresAt < 1e12 ? 1000 : 1) - now) / 1000)) : GAME_RULES.challengeDurationSeconds,
    result: visible ? session?.result : undefined,
    recoveryNeeded: visible && recoveryRequired.current && phase !== 'confirmed', recovering: visible && phase === 'recovering',
    recoveryNeedsPaymentHash: visible && !session?.recoveryCheckpoint && !validHash(paymentHash) && !validHash(session?.paymentHash),
    start, send, finish, nextRound, reset, recover };
}
