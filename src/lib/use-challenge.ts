'use client';
import { useState, useEffect, useCallback, useRef } from 'react';
import { useAccount, usePublicClient, useWriteContract } from 'wagmi';
import { decodeEventLog, type Abi, type Address, type Hash, type TransactionReceipt } from 'viem';
import arenaAbi from '../../contracts/abi/RugArena.json';
import { api } from './api';
import { useArena } from './arena-context';
import { monad } from './wagmi';
import type { ChallengeSession, Attestation, GameSnapshot } from './types';
import { GAME_RULES } from '../../shared/config';

export type ChallengePhase = 'idle' | 'starting' | 'active' | 'thinking' | 'resolved' | 'signing' | 'submitting' | 'confirmed' | 'failed';
type PendingAction = { kind: 'claim' | 'round'; hash: Hash; roundId?: string };
type ChainRound = { id: bigint; prizePool: bigint; challengeFee: bigint; endsAt: bigint; active: boolean; winner: Address; reward: bigint; rewardClaimed: boolean };
const abi = arenaAbi as Abi;
const validHash = (value: unknown): value is Hash => typeof value === 'string' && /^0x[\da-f]{64}$/i.test(value);
const publicRound = (round: ChainRound): GameSnapshot['round'] => ({ ...round, id: String(round.id), prizePool: String(round.prizePool), challengeFee: String(round.challengeFee), endsAt: Number(round.endsAt), reward: String(round.reward) });
const explain = (cause: unknown) => {
  const message = cause instanceof Error ? cause.message : String(cause);
  if (/reject|denied|4001/i.test(message)) return '已取消签名，本轮结果已保留，可以再次结算。';
  if (/insufficient funds|exceeds the balance/i.test(message)) return '测试 MON 余额不足，请确认钱包中有挑战费和 Gas。';
  if (/RoundClosed|WrongRound|RoundNotActive|round.*(ended|active)|RoundMismatch/i.test(message)) return '这一公共回合已经结束，本轮未扣挑战费。可以加入下一回合。';
  if (/deadline|expired/i.test(message)) return '结算凭证已过期，请重新结束本轮以获取凭证。';
  return message.split('\n')[0].slice(0, 190);
};

function findEvent(receipt: TransactionReceipt, contract: string, name: string, matches: (args: Record<string, unknown>) => boolean) {
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== contract.toLowerCase()) continue;
    try {
      const event = decodeEventLog({ abi, data: log.data, topics: log.topics }) as unknown as { eventName: string; args: Record<string, unknown> };
      if (event.eventName === name && matches(event.args)) return event.args;
    } catch { /* Only the expected arena event confirms this action. */ }
  }
}

export function useChallenge() {
  const { address, chainId } = useAccount();
  const { state, refresh, reportTransaction } = useArena();
  const client = usePublicClient({ chainId: monad.id });
  const { writeContractAsync } = useWriteContract();
  const [session, setSession] = useState<ChallengeSession | null>(null);
  const [phase, setPhase] = useState<ChallengePhase>('idle');
  const [error, setError] = useState<string | null>(null);
  const [txHash, setTxHash] = useState<string | null>(null);
  const [claimHash, setClaimHash] = useState<string | null>(null);
  const [claiming, setClaiming] = useState(false);
  const [rewardRoundIds, setRewardRoundIds] = useState<string[]>([]);
  const [rewardRound, setRewardRound] = useState<GameSnapshot['round'] | null>(null);
  const [pendingAction, setPendingAction] = useState<PendingAction | null>(null);
  const [hydratedKey, setHydratedKey] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  const busy = useRef(false);
  const operation = useRef(0);
  const pendingActionRef = useRef<PendingAction | null>(null);
  const settlementRef = useRef<string | null>(null);
  const storageKey = address && state?.contractAddress ? `rug-arena:${monad.id}:${state.contractAddress}:${address.toLowerCase()}` : null;
  const scope = useRef(storageKey);
  scope.current = storageKey;

  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, []);
  useEffect(() => {
    const version = ++operation.current;
    busy.current = false; pendingActionRef.current = null; settlementRef.current = null;
    setSession(null); setTxHash(null); setClaimHash(null); setError(null); setPhase('idle');
    setPendingAction(null); setClaiming(false); setRewardRoundIds([]); setRewardRound(null);
    if (storageKey) {
      try {
        const raw = localStorage.getItem(storageKey);
        if (raw) {
          const saved = JSON.parse(raw) as { session?: ChallengeSession; txHash?: string; claimHash?: string; rewardRoundIds?: string[]; pendingAction?: PendingAction };
          const restored = saved.session && saved.session.player.toLowerCase() === address?.toLowerCase() ? saved.session : null;
          const hash = validHash(saved.txHash) ? saved.txHash : null;
          setSession(restored); setTxHash(hash); settlementRef.current = hash;
          setClaimHash(validHash(saved.claimHash) ? saved.claimHash : null);
          setRewardRoundIds((saved.rewardRoundIds || []).filter(id => /^\d+$/.test(id)));
          if (saved.pendingAction && validHash(saved.pendingAction.hash) && ['claim', 'round'].includes(saved.pendingAction.kind)) {
            pendingActionRef.current = saved.pendingAction; setPendingAction(saved.pendingAction); setClaiming(true);
          }
          // Cached confirmations are checked against actual receipts again after reload.
          setPhase(hash ? 'submitting' : restored?.attestation ? 'resolved' : restored ? 'active' : 'idle');
          if (restored && !hash) {
            void api<ChallengeSession>(`/api/game/challenges/${restored.id}`, { headers: { 'x-challenge-token': restored.token } }).then(next => {
              if (scope.current !== storageKey || operation.current !== version) return;
              setSession(next); setPhase(next.attestation ? 'resolved' : 'active');
            }).catch(cause => {
              if (scope.current !== storageKey || operation.current !== version) return;
              if (/not found|invalid challenge session/i.test(String(cause))) { setSession(null); setPhase('idle'); }
              setError(explain(cause));
            });
          }
        }
      } catch { /* An unavailable local cache never blocks play. */ }
    }
    setHydratedKey(storageKey);
  }, [storageKey, address]);
  useEffect(() => {
    // A key in React state prevents the loading commit from saving the previous context.
    if (!storageKey || hydratedKey !== storageKey || (session && session.player.toLowerCase() !== address?.toLowerCase())) return;
    try { localStorage.setItem(storageKey, JSON.stringify({ session, txHash, phase, claimHash, rewardRoundIds, pendingAction })); }
    catch { /* Browsers may disable localStorage. */ }
  }, [storageKey, hydratedKey, session, txHash, phase, claimHash, rewardRoundIds, pendingAction, address]);

  useEffect(() => {
    if (!txHash || phase !== 'submitting' || !client || !session || !state?.contractAddress || hydratedKey !== storageKey) return;
    let cancelled = false, checking = false;
    const check = async () => {
      if (checking) return;
      checking = true;
      try {
        const receipt = await client.getTransactionReceipt({ hash: txHash as Hash });
        if (cancelled) return;
        const settled = findEvent(receipt, state.contractAddress!, 'ChallengeSettled', args =>
          String(args.challengeId).toLowerCase() === session.id.toLowerCase() && String(args.player).toLowerCase() === session.player.toLowerCase() && String(args.roundId) === session.roundId);
        if (receipt.status === 'success' && settled) {
          setPhase('confirmed'); setError(null);
          if (settled.success) setRewardRoundIds(ids => ids.includes(session.roundId) ? ids : [...ids, session.roundId]);
          void reportTransaction(txHash, session.id); void refresh();
        } else {
          setPhase('failed'); setError(receipt.status === 'reverted' ? '交易已回滚，挑战费未被合约收取。检查公共回合后可重试。' : '这笔交易没有记录当前挑战，请重新结算。');
          settlementRef.current = null; setTxHash(null);
        }
      } catch { /* Missing receipts and RPC errors keep the original transaction pending. */ }
      finally { checking = false; }
    };
    void check(); const interval = setInterval(() => void check(), 2000);
    return () => { cancelled = true; clearInterval(interval); };
  }, [txHash, phase, client, session, state?.contractAddress, hydratedKey, storageKey, refresh, reportTransaction]);

  useEffect(() => {
    if (!pendingAction || !client || !state?.contractAddress || hydratedKey !== storageKey) return;
    let cancelled = false, checking = false;
    const action = pendingAction;
    const check = async () => {
      if (checking) return;
      checking = true;
      try {
        const receipt = await client.getTransactionReceipt({ hash: action.hash });
        if (cancelled) return;
        const event = findEvent(receipt, state.contractAddress!, action.kind === 'claim' ? 'RewardClaimed' : 'GameRoundStarted', args =>
          action.kind === 'round' || (String(args.roundId) === action.roundId && String(args.player).toLowerCase() === address?.toLowerCase()));
        if (receipt.status !== 'success' || !event) setError('交易已回滚或没有执行该操作，可以重新尝试。');
        else {
          setError(null);
          if (action.kind === 'claim') setRewardRoundIds(ids => ids.filter(id => id !== action.roundId));
          void reportTransaction(action.hash); void refresh();
        }
        pendingActionRef.current = null; setPendingAction(null); setClaiming(false);
      } catch { /* A receipt timeout is not a failed or cancelled transaction. */ }
      finally { checking = false; }
    };
    void check(); const interval = setInterval(() => void check(), 2000);
    return () => { cancelled = true; clearInterval(interval); };
  }, [pendingAction, client, state?.contractAddress, hydratedKey, storageKey, address, reportTransaction, refresh]);

  useEffect(() => {
    if (!client || !state?.contractAddress || !address || hydratedKey !== storageKey) return;
    let cancelled = false;
    void Promise.all(rewardRoundIds.map(async id => {
      try { return { id, round: await client.readContract({ address: state.contractAddress as Address, abi, functionName: 'getRound', args: [BigInt(id)] }) as ChainRound }; }
      catch { return { id, round: null }; }
    })).then(records => {
      if (cancelled) return;
      const unclaimed = records.filter(({ round }) => !round || (!round.rewardClaimed && round.reward > 0n && round.winner.toLowerCase() === address.toLowerCase()));
      if (unclaimed.length !== rewardRoundIds.length) setRewardRoundIds(unclaimed.map(item => item.id));
      const first = unclaimed.find(item => item.round)?.round;
      setRewardRound(first ? publicRound(first) : null);
    });
    return () => { cancelled = true; };
  }, [rewardRoundIds, client, state?.contractAddress, state?.round.id, state?.round.rewardClaimed, state?.metrics.confirmedTransactions, address, hydratedKey, storageKey]);

  const checkReady = (snapshot = state) => {
    if (!address) throw new Error('先连接你的 Monad Testnet 钱包。');
    if (chainId !== monad.id) throw new Error('请先将钱包切换到 Monad Testnet。');
    if (!snapshot?.configured || !snapshot.contractAddress) throw new Error('竞技场正在等待合约部署，请稍后再来。');
    if (snapshot.chainId !== monad.id) throw new Error('当前服务未连接 Monad Testnet。');
    return snapshot;
  };
  const begin = () => {
    const version = ++operation.current, key = storageKey;
    busy.current = true;
    return { key, current: () => scope.current === key && operation.current === version,
      end: () => { if (scope.current === key && operation.current === version) busy.current = false; } };
  };
  const storePending = (key: string | null, values: Record<string, unknown>) => {
    if (!key) return;
    try {
      const saved = JSON.parse(localStorage.getItem(key) || '{}');
      localStorage.setItem(key, JSON.stringify({ ...saved, session, rewardRoundIds, ...values }));
    } catch { /* Pending state is also kept in memory. */ }
  };
  const blocked = () => busy.current || !!pendingActionRef.current || (!!settlementRef.current && phase !== 'confirmed');
  const start = async () => {
    if (blocked()) return;
    const task = begin(); setError(null); setPhase('starting');
    try {
      const snapshot = await refresh(); if (!task.current()) return;
      checkReady(snapshot);
      const next = await api<ChallengeSession>('/api/challenges/start', { method: 'POST', body: JSON.stringify({ player: address }) });
      if (!task.current()) return;
      setSession(next); setTxHash(null); settlementRef.current = null; setPhase(next.attestation ? 'resolved' : 'active');
    } catch (cause) { if (task.current()) { setError(explain(cause)); setPhase(phase); } }
    finally { task.end(); }
  };
  const finishSession = (current: ChallengeSession) => api<ChallengeSession>(`/api/challenges/${current.id}/finish`, { method: 'POST', body: JSON.stringify({ token: current.token }) });
  const send = async (message: string) => {
    if (!session || blocked() || phase !== 'active' || !message.trim()) return;
    const task = begin(); setError(null); setPhase('thinking');
    try {
      let next = await api<ChallengeSession>(`/api/challenges/${session.id}/message`, { method: 'POST', body: JSON.stringify({ token: session.token, message: message.trim() }) });
      if (!next.attestation && (next.result?.result || next.messages.filter(item => item.role === 'user').length >= next.maxMessages)) next = await finishSession(next);
      if (!task.current()) return;
      setSession(next); setPhase(next.attestation ? 'resolved' : 'active');
    } catch (cause) { if (task.current()) { setError(explain(cause)); setPhase(session.attestation ? 'resolved' : 'active'); } }
    finally { task.end(); }
  };
  const finish = async () => {
    if (!session || blocked() || txHash) return;
    const task = begin(); setError(null); setPhase('thinking');
    try { const next = await finishSession(session); if (task.current()) { setSession(next); setPhase('resolved'); } }
    catch (cause) { if (task.current()) { setError(explain(cause)); setPhase(session.attestation ? 'resolved' : 'active'); } }
    finally { task.end(); }
  };
  const settle = async () => {
    if (!session?.attestation || blocked() || txHash || !client) return;
    const task = begin(); setError(null);
    try {
      const snapshot = checkReady(await refresh()); if (!task.current()) return;
      const round = await client.readContract({ address: snapshot.contractAddress as Address, abi, functionName: 'getCurrentRound' }) as ChainRound;
      if (!task.current()) return;
      if (!round.active || String(round.id) !== session.roundId) throw new Error('这一公共回合已经结束，本轮未扣挑战费。可以加入下一回合。');
      let attestation: Attestation = session.attestation;
      let latestSession = session;
      if (Number(attestation.result.deadline) <= Date.now() / 1000 + 10) {
        latestSession = await finishSession(session);
        if (!task.current()) return;
        if (!latestSession.attestation) throw new Error('本轮结果尚未就绪。');
        attestation = latestSession.attestation; setSession(latestSession);
      }
      const r = attestation.result;
      if (r.player.toLowerCase() !== address?.toLowerCase()) throw new Error('请切回本轮挑战使用的钱包。');
      setPhase('signing');
      const hash = await writeContractAsync({ address: snapshot.contractAddress as Address, abi, functionName: 'settleChallenge', args: [{ ...r, roundId: BigInt(r.roundId), score: BigInt(r.score), deadline: BigInt(r.deadline) }, attestation.signature], value: round.challengeFee, chainId: monad.id });
      storePending(task.key, { session: latestSession, txHash: hash, phase: 'submitting' });
      void reportTransaction(hash, session.id);
      if (!task.current()) return;
      settlementRef.current = hash; setTxHash(hash); setPhase('submitting');
    } catch (cause) { if (task.current()) { setError(explain(cause)); setPhase('failed'); } }
    finally { task.end(); }
  };
  const claim = async () => {
    if (blocked() || !client || !rewardRound) return;
    const task = begin(); setClaiming(true); setError(null);
    try {
      const snapshot = checkReady(await refresh()); if (!task.current()) return;
      const round = await client.readContract({ address: snapshot.contractAddress as Address, abi, functionName: 'getRound', args: [BigInt(rewardRound.id)] }) as ChainRound;
      if (!task.current()) return;
      if (round.rewardClaimed || round.reward === 0n || round.winner.toLowerCase() !== address?.toLowerCase()) throw new Error('这一回合没有待领取奖励，请刷新查看状态。');
      const hash = await writeContractAsync({ address: snapshot.contractAddress as Address, abi, functionName: 'claimReward', args: [round.id], chainId: monad.id });
      const action: PendingAction = { kind: 'claim', hash, roundId: String(round.id) };
      storePending(task.key, { claimHash: hash, pendingAction: action }); void reportTransaction(hash);
      if (!task.current()) return;
      pendingActionRef.current = action; setPendingAction(action); setClaimHash(hash);
    } catch (cause) { if (task.current()) setError(explain(cause)); }
    finally { if (task.current() && !pendingActionRef.current) setClaiming(false); task.end(); }
  };
  const nextRound = async () => {
    if (blocked() || !client) return;
    const task = begin(); setClaiming(true); setError(null);
    try {
      const snapshot = checkReady(await refresh()); if (!task.current()) return;
      const round = await client.readContract({ address: snapshot.contractAddress as Address, abi, functionName: 'getCurrentRound' }) as ChainRound;
      if (!task.current()) return;
      if (round.active) { await refresh(); return; }
      const hash = await writeContractAsync({ address: snapshot.contractAddress as Address, abi, functionName: 'startGameRound', chainId: monad.id });
      const action: PendingAction = { kind: 'round', hash };
      storePending(task.key, { pendingAction: action }); void reportTransaction(hash);
      if (!task.current()) return;
      pendingActionRef.current = action; setPendingAction(action);
    } catch (cause) { if (task.current()) setError(explain(cause)); }
    finally { if (task.current() && !pendingActionRef.current) setClaiming(false); task.end(); }
  };
  const reset = useCallback(() => {
    if (busy.current || pendingActionRef.current || (settlementRef.current && phase !== 'confirmed')) return;
    operation.current += 1; settlementRef.current = null;
    setSession(null); setTxHash(null); setPhase('idle'); setError(null);
    // Unclaimed rewards and their transaction state survive starting the next challenge.
  }, [phase]);
  const visible = hydratedKey === storageKey;
  const used = session?.messages.filter(item => item.role === 'user').length || 0;
  return { session: visible ? session : null, messages: visible ? session?.messages || [] : [], phase: visible ? phase : 'idle', error: visible ? error : null,
    txHash: visible ? txHash : null, claimHash: visible ? claimHash : null, claiming: claiming || !!pendingAction,
    rewardRound: visible ? rewardRound : null, canClaim: visible && !!rewardRound && !rewardRound.rewardClaimed,
    pendingActionHash: visible ? pendingAction?.hash || null : null,
    remaining: Math.max(0, (session?.maxMessages || GAME_RULES.maxMessages) - used),
    secondsLeft: session ? Math.max(0, Math.ceil((session.expiresAt * (session.expiresAt < 1e12 ? 1000 : 1) - now) / 1000)) : GAME_RULES.challengeDurationSeconds,
    result: visible ? session?.result : undefined, start, send, finish, settle, claim, nextRound, reset };
}
