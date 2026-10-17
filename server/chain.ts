import { readFileSync } from 'node:fs';
import {
  createPublicClient, decodeEventLog, decodeFunctionData, defineChain, getAddress,
  http, parseEther, type Abi, type Address, type Hex,
} from 'viem';
import { GAME_RULES, TESTNET } from '../shared/config';
import type { GameSnapshot, LeaderboardEntry } from '../shared/types';
import type { ServerConfig } from './config';

export interface ChainEvent { type: string; roundId: string; payload: Record<string, unknown> }
export interface ChainWorld {
  round: GameSnapshot['round'];
  leaderboard: LeaderboardEntry[];
  totalChallenges: number;
  confirmedTransactions: number;
  pendingTransactions: number;
  resultSigner?: Address;
}
export interface TransactionView {
  hash: Hex;
  status: 'pending' | 'success' | 'reverted';
  from: Address;
  to: Address | null;
  value: string;
  blockNumber: string | null;
  gasUsed: string | null;
  effectiveGasPrice: string | null;
  fee: string | null;
  chainId: number;
  explorerUrl: string;
  functionName?: string;
}
export interface ChainAdapter {
  configured: boolean;
  chainId: number;
  contractAddress?: Address;
  world(): ChainWorld;
  refresh(): Promise<void>;
  onEvent(listener: (event: ChainEvent) => void): void;
  observeTransaction(hash: Hex, challengeId?: string): Promise<void>;
  getTransaction(hash: Hex): Promise<TransactionView>;
}

export function emptyWorld(): ChainWorld {
  return {
    round: { id: '0', prizePool: '0', challengeFee: parseEther(GAME_RULES.challengeFeeMon).toString(), endsAt: 0, active: false, winner: '0x0000000000000000000000000000000000000000', reward: '0', rewardClaimed: false },
    leaderboard: [], totalChallenges: 0, confirmedTransactions: 0, pendingTransactions: 0,
  };
}

/** Only this adapter turns RPC observations into public chain facts. No wallet or write client exists here. */
export function createChainAdapter(config: ServerConfig): ChainAdapter {
  let current = emptyWorld();
  const listeners = new Set<(event: ChainEvent) => void>();
  const pending = new Map<Hex, { challengeId?: string; since: number }>();
  const confirmed = new Set<string>();
  const seenLogs = new Set<string>();
  let nextBlock: bigint | undefined;
  let refreshing: Promise<void> | undefined;
  let checkedNetwork = false;
  const chain = defineChain({ id: config.chainId, name: config.chainId === 31337 ? 'Local Arena test chain' : TESTNET.name, nativeCurrency: { name: 'MON', symbol: 'MON', decimals: 18 }, rpcUrls: { default: { http: [config.rpcUrl] } } });
  const client = createPublicClient({ chain, transport: http(config.rpcUrl, { timeout: 12_000, retryCount: 1 }) });
  let abi: Abi | undefined;
  function getAbi(): Abi {
    if (!abi) {
      const artifact = JSON.parse(readFileSync(new URL('../contracts/abi/RugArena.json', import.meta.url), 'utf8'));
      abi = Array.isArray(artifact) ? artifact : artifact.abi;
    }
    return abi!;
  }
  function emit(type: string, roundId: string, payload: Record<string, unknown>) {
    for (const listener of listeners) listener({ type, roundId, payload });
  }
  function processLogs(logs: { transactionHash: Hex | null; logIndex: number | null; topics: readonly Hex[]; data: Hex; blockNumber: bigint | null }[], publish: boolean, historical = false) {
    for (const log of logs) {
      const key = `${log.transactionHash}:${log.logIndex}`;
      if (seenLogs.has(key)) continue;
      seenLogs.add(key);
      try {
        const decoded = decodeEventLog({ abi: getAbi(), data: log.data, topics: log.topics as [Hex, ...Hex[]] }) as unknown as { eventName: string; args: Record<string, unknown> };
        const args = decoded.args;
        const payload = Object.fromEntries(Object.entries(args).map(([k, v]) => [k, typeof v === 'bigint' ? v.toString() : v]));
        Object.assign(payload, { hash: log.transactionHash, transactionHash: log.transactionHash, blockNumber: log.blockNumber?.toString(), status: 'confirmed', historical });
        const roundId = String(args.roundId ?? current.round.id);
        if (log.transactionHash) {
          confirmed.add(log.transactionHash);
          pending.delete(log.transactionHash);
        }
        if (!publish) continue;
        switch (decoded.eventName) {
          case 'ChallengeSettled': emit('chain:confirmed', roundId, { ...payload, action: 'settleChallenge' }); break;
          case 'PrizePoolUpdated': emit('pool:updated', roundId, payload); break;
          case 'WinnerDeclared': emit('game:winner', roundId, payload); break;
          case 'RewardClaimed':
            emit('reward:claimed', roundId, payload);
            emit('chain:confirmed', roundId, { ...payload, action: 'claimReward' });
            break;
          case 'GameRoundStarted': emit('round:started', roundId, payload); break;
        }
      } catch {
        // Ignore unrelated events if an address is accidentally configured with another contract.
      }
    }
  }
  async function getTransaction(hash: Hex): Promise<TransactionView> {
    const tx = await client.getTransaction({ hash });
    const receipt = await client.getTransactionReceipt({ hash }).catch(() => null);
    let functionName: string | undefined;
    if (tx.to?.toLowerCase() === config.contractAddress?.toLowerCase()) {
      try { functionName = decodeFunctionData({ abi: getAbi(), data: tx.input }).functionName; } catch { /* transfer or other method */ }
    }
    return {
      hash: tx.hash, status: receipt ? receipt.status === 'success' ? 'success' : 'reverted' : 'pending',
      from: tx.from, to: tx.to, value: tx.value.toString(), blockNumber: receipt?.blockNumber.toString() ?? null,
      gasUsed: receipt?.gasUsed.toString() ?? null, effectiveGasPrice: receipt?.effectiveGasPrice.toString() ?? null,
      fee: receipt ? (receipt.gasUsed * receipt.effectiveGasPrice).toString() : null,
      chainId: config.chainId, explorerUrl: config.chainId === TESTNET.chainId ? `${TESTNET.explorer}/tx/${hash}` : '', functionName,
    };
  }
  async function refreshWorld() {
    if (!config.contractAddress) return;
    if (!checkedNetwork) {
      const actualChainId = await client.getChainId();
      if (actualChainId !== config.chainId) throw new Error(`RPC chain mismatch: expected ${config.chainId}, received ${actualChainId}.`);
      const code = await client.getBytecode({ address: config.contractAddress });
      if (!code || code === '0x') throw new Error('No RugArena contract was found at ARENA_CONTRACT_ADDRESS.');
      checkedNetwork = true;
    }
    const read = (functionName: string, args?: unknown[]) => client.readContract({ address: config.contractAddress!, abi: getAbi(), functionName, args });
    const [rawRound, players, total, signer, head] = await Promise.all([
      read('getCurrentRound'), read('getPlayers'), read('totalChallenges'), read('resultSigner'), client.getBlockNumber(),
    ]);
    const round = rawRound as { id: bigint; prizePool: bigint; challengeFee: bigint; endsAt: bigint; active: boolean; winner: Address; reward: bigint; rewardClaimed: boolean };
    const leaderboard = Number(total) === current.totalChallenges && current.leaderboard.length === (players as Address[]).length
      ? [...current.leaderboard]
      : await Promise.all((players as Address[]).map(async (address) => {
        const stats = await read('getPlayerStats', [address]) as { attempts: bigint; successes: bigint; score: bigint; wins: bigint };
        return { address, attempts: Number(stats.attempts), successes: Number(stats.successes), score: Number(stats.score), wins: Number(stats.wins) };
      }));
    leaderboard.sort((a, b) => b.score - a.score || b.successes - a.successes || a.address.localeCompare(b.address));
    const previousBoard = JSON.stringify(current.leaderboard);
    current = {
      round: { id: round.id.toString(), prizePool: round.prizePool.toString(), challengeFee: round.challengeFee.toString(), endsAt: Number(round.endsAt), active: round.active, winner: round.winner, reward: round.reward.toString(), rewardClaimed: round.rewardClaimed },
      leaderboard, totalChallenges: Number(total), resultSigner: signer as Address,
      confirmedTransactions: confirmed.size, pendingTransactions: pending.size,
    };
    const initial = nextBlock === undefined;
    if (nextBlock === undefined) nextBlock = config.deploymentBlock ?? (head > 5000n ? head - 5000n : 0n);
    // Monad's public RPC allows at most 100 blocks per inclusive eth_getLogs range.
    let cursor: bigint = nextBlock;
    while (cursor <= head) {
      const toBlock: bigint = cursor + 99n < head ? cursor + 99n : head;
      const logs = await client.getLogs({ address: config.contractAddress, fromBlock: cursor, toBlock });
      processLogs(logs, true, initial);
      cursor = toBlock + 1n;
      nextBlock = cursor;
    }
    for (const [hash, candidate] of pending) {
      const receipt = await client.getTransactionReceipt({ hash }).catch(() => null);
      if (receipt?.status === 'reverted') {
        pending.delete(hash);
        emit('chain:failed', current.round.id, { hash, challengeId: candidate.challengeId, reason: 'Transaction reverted on chain.' });
      } else if (receipt) {
        processLogs(receipt.logs.filter((l) => l.address.toLowerCase() === config.contractAddress!.toLowerCase()), true);
        pending.delete(hash);
      } else if (Date.now() - candidate.since > 10 * 60 * 1000) {
        // Being unobserved is not a failed transaction; retain no false failure claim.
        pending.delete(hash);
      }
    }
    current.confirmedTransactions = confirmed.size;
    current.pendingTransactions = pending.size;
    if (previousBoard !== JSON.stringify(leaderboard)) emit('leaderboard:updated', current.round.id, { leaderboard });
  }
  return {
    configured: !!config.contractAddress, chainId: config.chainId, contractAddress: config.contractAddress,
    world: () => ({ ...current, pendingTransactions: pending.size }),
    onEvent: (listener) => { listeners.add(listener); },
    refresh() {
      if (!refreshing) refreshing = refreshWorld().finally(() => { refreshing = undefined; });
      return refreshing;
    },
    getTransaction,
    async observeTransaction(hash, challengeId) {
      hash = hash.toLowerCase() as Hex;
      if (!config.contractAddress) throw new Error('Contract is not configured.');
      const tx = await client.getTransaction({ hash });
      if (tx.to?.toLowerCase() !== config.contractAddress.toLowerCase()) throw new Error('Transaction does not target RugArena.');
      const decoded = decodeFunctionData({ abi: getAbi(), data: tx.input });
      if (!['settleChallenge', 'claimReward', 'startGameRound'].includes(decoded.functionName)) throw new Error('Transaction is not an arena game action.');
      if (decoded.functionName === 'settleChallenge') {
        const result = (decoded.args as unknown[])[0] as { player: Address; challengeId: Hex };
        if (getAddress(result.player) !== getAddress(tx.from)) throw new Error('Settlement sender does not match the result player.');
        if (challengeId && result.challengeId.toLowerCase() !== challengeId.toLowerCase()) throw new Error('Challenge ID does not match transaction data.');
        challengeId = result.challengeId;
      }
      if (confirmed.has(hash) || pending.has(hash)) return;
      pending.set(hash, { challengeId, since: Date.now() });
      emit('chain:submitted', current.round.id, { hash, challengeId, player: tx.from, action: decoded.functionName, status: 'pending' });
      await this.refresh();
    },
  };
}
