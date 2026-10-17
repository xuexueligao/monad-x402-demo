import { readFileSync } from 'node:fs';
import {
  createPublicClient, createWalletClient, decodeEventLog, decodeFunctionData, defineChain, getAddress,
  http, parseEther, type Abi, type Address, type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { GAME_RULES, TESTNET } from '../shared/config';
import type { Attestation, ChallengeSession, GameSnapshot, LeaderboardEntry } from '../shared/types';
import type { ServerConfig } from './config';

export interface ChainEvent { type: string; roundId: string; payload: Record<string, unknown> }
export interface ChainWorld {
  round: GameSnapshot['round'];
  leaderboard: LeaderboardEntry[];
  totalChallenges: number;
  confirmedTransactions: number;
  pendingTransactions: number;
  resultSigner?: Address;
  relayerAddress?: Address;
  relayerBalance?: string;
}
export interface ChainChallenge {
  player: Address;
  roundId: string;
  success: boolean;
  score: string;
  fee: string;
  reward: string;
  transcriptHash: Hex;
  settledAt: number;
  settled: boolean;
  enteredAt: number;
  expiresAt: number;
}
export interface SettlementOptions { hash?: Hex; onSubmitted?: (hash: Hex) => void }
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
  getChallenge(id: Hex): Promise<ChainChallenge>;
  verifyPayment(session: Pick<ChallengeSession, 'id' | 'player' | 'roundId' | 'fee'>, hash: Hex): Promise<ChainChallenge>;
  submitSettlement(attestation: Attestation, options?: SettlementOptions): Promise<{ hash?: Hex; challenge: ChainChallenge }>;
}

export function emptyWorld(): ChainWorld {
  return {
    round: { id: '0', prizePool: '0', challengeFee: parseEther(GAME_RULES.challengeFeeMon).toString(), endsAt: 0, active: false, winner: '0x0000000000000000000000000000000000000000', reward: '0', rewardClaimed: false },
    leaderboard: [], totalChallenges: 0, confirmedTransactions: 0, pendingTransactions: 0,
  };
}

/** Only this adapter turns RPC observations into public chain facts. Its relayer can only settle signed game results. */
export function createChainAdapter(config: ServerConfig): ChainAdapter {
  let current = emptyWorld();
  const listeners = new Set<(event: ChainEvent) => void>();
  const pending = new Map<Hex, { challengeId?: string; since: number }>();
  const confirmed = new Set<string>();
  const seenLogs = new Set<string>();
  const settlementHashes = new Map<string, Hex>();
  let relayQueue: Promise<unknown> = Promise.resolve();
  let nextBlock: bigint | undefined;
  let refreshing: Promise<void> | undefined;
  let checkedNetwork = false;
  const chain = defineChain({ id: config.chainId, name: config.chainId === 31337 ? 'Local Arena test chain' : TESTNET.name, nativeCurrency: { name: 'MON', symbol: 'MON', decimals: 18 }, rpcUrls: { default: { http: [config.rpcUrl] } } });
  const client = createPublicClient({ chain, transport: http(config.rpcUrl, { timeout: 12_000, retryCount: 1 }) });
  const account = config.signerKey ? privateKeyToAccount(config.signerKey) : undefined;
  const wallet = account ? createWalletClient({ account, chain, transport: http(config.rpcUrl, { timeout: 12_000, retryCount: 1 }) }) : undefined;
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
        if (decoded.eventName === 'ChallengeSettled' && log.transactionHash && typeof args.challengeId === 'string') settlementHashes.set(args.challengeId.toLowerCase(), log.transactionHash);
        if (log.transactionHash) {
          confirmed.add(log.transactionHash);
          pending.delete(log.transactionHash);
        }
        if (!publish) continue;
        switch (decoded.eventName) {
          case 'ChallengeEntered':
            emit('chain:confirmed', roundId, { ...payload, action: 'enterChallenge' });
            emit('challenge:paid', roundId, payload);
            break;
          case 'ChallengeSettled': emit('chain:confirmed', roundId, { ...payload, action: 'settleChallenge' }); break;
          case 'PrizePoolUpdated': emit('pool:updated', roundId, payload); break;
          case 'WinnerDeclared': emit('game:winner', roundId, payload); break;
          case 'RewardClaimed':
            emit('reward:claimed', roundId, payload);
            emit('chain:confirmed', roundId, { ...payload, action: 'claimReward' });
            break;
          case 'RewardPaid': emit('reward:paid', roundId, payload); break;
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
  async function getChallenge(id: Hex): Promise<ChainChallenge> {
    if (!config.contractAddress) throw new Error('Contract is not configured.');
    const record = await client.readContract({ address: config.contractAddress, abi: getAbi(), functionName: 'getChallenge', args: [id] }) as {
      player: Address; roundId: bigint; success: boolean; score: bigint; fee: bigint; reward: bigint;
      transcriptHash: Hex; settledAt: bigint; settled: boolean; enteredAt: bigint; expiresAt: bigint;
    };
    return { ...record, roundId: String(record.roundId), score: String(record.score), fee: String(record.fee), reward: String(record.reward), settledAt: Number(record.settledAt), enteredAt: Number(record.enteredAt), expiresAt: Number(record.expiresAt) };
  }
  function assertPaymentIdentity(session: Pick<ChallengeSession, 'id' | 'player' | 'roundId' | 'fee'>, record: ChainChallenge) {
    if (getAddress(record.player) !== getAddress(session.player) || record.roundId !== session.roundId || record.fee !== session.fee || !record.enteredAt) throw new Error('The on-chain payment does not match this challenge and wallet.');
  }
  async function verifyPayment(session: Pick<ChallengeSession, 'id' | 'player' | 'roundId' | 'fee'>, hash: Hex): Promise<ChainChallenge> {
    if (!config.contractAddress) throw new Error('Contract is not configured.');
    const [tx, receipt] = await Promise.all([client.getTransaction({ hash }), client.getTransactionReceipt({ hash })]);
    if (receipt.status !== 'success') throw new Error('The entry transaction reverted or is not confirmed.');
    if (tx.to?.toLowerCase() !== config.contractAddress.toLowerCase() || getAddress(tx.from) !== getAddress(session.player)) throw new Error('The entry payment must come from this player and target RugArena.');
    const decoded = decodeFunctionData({ abi: getAbi(), data: tx.input });
    const args = decoded.args as unknown[];
    if (decoded.functionName !== 'enterChallenge' || String(args[0]).toLowerCase() !== session.id.toLowerCase() || String(args[1]) !== session.roundId || tx.value !== BigInt(session.fee)) throw new Error('The payment challenge, round, or fee is incorrect.');
    const entry = receipt.logs.filter((log) => log.address.toLowerCase() === config.contractAddress!.toLowerCase()).some((log) => {
      try {
        const event = decodeEventLog({ abi: getAbi(), data: log.data, topics: log.topics }) as unknown as { eventName: string; args: Record<string, unknown> };
        return event.eventName === 'ChallengeEntered' && String(event.args.challengeId).toLowerCase() === session.id.toLowerCase() && getAddress(String(event.args.player)) === getAddress(session.player) && String(event.args.roundId) === session.roundId && String(event.args.fee) === session.fee;
      } catch { return false; }
    });
    if (!entry) throw new Error('No matching confirmed ChallengeEntered event was found.');
    const record = await getChallenge(session.id as Hex);
    assertPaymentIdentity(session, record);
    processLogs(receipt.logs.filter((log) => log.address.toLowerCase() === config.contractAddress!.toLowerCase()), true);
    await refreshWorld().catch(() => {});
    return record;
  }
  async function relaySettlement(attestation: Attestation, options: SettlementOptions = {}): Promise<{ hash?: Hex; challenge: ChainChallenge }> {
    const result = attestation.result;
    let record = await getChallenge(result.challengeId);
    assertPaymentIdentity({ id: result.challengeId, player: result.player, roundId: result.roundId, fee: record.fee }, record);
    if (record.settled) return { hash: options.hash || settlementHashes.get(result.challengeId.toLowerCase()), challenge: record };
    if (!wallet || !account || !config.contractAddress) throw new Error('The settlement relayer is not configured.');
    let hash = options.hash;
    if (hash) {
      const known = await client.getTransactionReceipt({ hash }).catch(() => null);
      if (known?.status === 'reverted') hash = undefined;
      // An unknown hash remains pending: never emit a second payout transaction on an RPC timeout.
    }
    if (!hash) {
      const actualChainId = await client.getChainId();
      if (actualChainId !== config.chainId) throw new Error('Relayer RPC network does not match the configured testnet.');
      const message = { ...result, roundId: BigInt(result.roundId), score: BigInt(result.score), deadline: BigInt(result.deadline) };
      const { request } = await client.simulateContract({ account, address: config.contractAddress, abi: getAbi(), functionName: 'settleChallenge', args: [message, attestation.signature] });
      hash = await wallet.writeContract(request);
      options.onSubmitted?.(hash);
      pending.set(hash, { challengeId: result.challengeId, since: Date.now() });
      emit('chain:submitted', result.roundId, { hash, challengeId: result.challengeId, player: result.player, relayer: account.address, action: 'settleChallenge', status: 'pending' });
    }
    const receipt = await client.waitForTransactionReceipt({ hash, timeout: 45_000 });
    if (receipt.status !== 'success') throw new Error('The settlement transaction reverted. You can retry the same judgement.');
    processLogs(receipt.logs.filter((log) => log.address.toLowerCase() === config.contractAddress!.toLowerCase()), true);
    record = await getChallenge(result.challengeId);
    if (!record.settled || record.success !== result.success || record.transcriptHash.toLowerCase() !== result.transcriptHash.toLowerCase()) throw new Error('Confirmed settlement does not match the signed judgement.');
    await refreshWorld().catch(() => {});
    return { hash, challenge: record };
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
    const [rawRound, players, total, signer, head, relayerBalance] = await Promise.all([
      read('getCurrentRound'), read('getPlayers'), read('totalChallenges'), read('resultSigner'), client.getBlockNumber(), account ? client.getBalance({ address: account.address }) : undefined,
    ]);
    const round = rawRound as { id: bigint; prizePool: bigint; challengeFee: bigint; endsAt: bigint; active: boolean; winner: Address; reward: bigint; rewardClaimed: boolean };
    // Attempts change on entry; scores change later on settlement, so total alone is not a valid cache key.
    const leaderboard = await Promise.all((players as Address[]).map(async (address) => {
        const stats = await read('getPlayerStats', [address]) as { attempts: bigint; successes: bigint; score: bigint; wins: bigint };
        return { address, attempts: Number(stats.attempts), successes: Number(stats.successes), score: Number(stats.score), wins: Number(stats.wins) };
      }));
    leaderboard.sort((a, b) => b.score - a.score || b.successes - a.successes || a.address.localeCompare(b.address));
    const previousBoard = JSON.stringify(current.leaderboard);
    current = {
      round: { id: round.id.toString(), prizePool: round.prizePool.toString(), challengeFee: round.challengeFee.toString(), endsAt: Number(round.endsAt), active: round.active, winner: round.winner, reward: round.reward.toString(), rewardClaimed: round.rewardClaimed },
      leaderboard, totalChallenges: Number(total), resultSigner: signer as Address,
      confirmedTransactions: confirmed.size, pendingTransactions: pending.size,
      ...(account ? { relayerAddress: account.address, relayerBalance: String(relayerBalance ?? 0n) } : {}),
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
    getChallenge,
    verifyPayment,
    submitSettlement(attestation, options) {
      // One relayer account: serialize send + confirmation to avoid colliding pending nonces.
      const operation = relayQueue.catch(() => {}).then(() => relaySettlement(attestation, options));
      relayQueue = operation;
      return operation;
    },
    async observeTransaction(hash, challengeId) {
      hash = hash.toLowerCase() as Hex;
      if (!config.contractAddress) throw new Error('Contract is not configured.');
      const tx = await client.getTransaction({ hash });
      if (tx.to?.toLowerCase() !== config.contractAddress.toLowerCase()) throw new Error('Transaction does not target RugArena.');
      const decoded = decodeFunctionData({ abi: getAbi(), data: tx.input });
      if (!['enterChallenge', 'settleChallenge', 'startGameRound'].includes(decoded.functionName)) throw new Error('Transaction is not an arena game action.');
      if (decoded.functionName === 'settleChallenge') {
        const result = (decoded.args as unknown[])[0] as { player: Address; challengeId: Hex };
        const paid = await getChallenge(result.challengeId);
        if (getAddress(result.player) !== getAddress(paid.player)) throw new Error('Settlement result does not match the recorded payment wallet.');
        if (challengeId && result.challengeId.toLowerCase() !== challengeId.toLowerCase()) throw new Error('Challenge ID does not match transaction data.');
        challengeId = result.challengeId;
      }
      if (decoded.functionName === 'enterChallenge') {
        const id = String((decoded.args as unknown[])[0]);
        if (challengeId && id.toLowerCase() !== challengeId.toLowerCase()) throw new Error('Challenge ID does not match entry transaction data.');
        challengeId = id;
      }
      if (confirmed.has(hash) || pending.has(hash)) return;
      pending.set(hash, { challengeId, since: Date.now() });
      emit('chain:submitted', current.round.id, { hash, challengeId, player: tx.from, action: decoded.functionName, status: 'pending' });
      await this.refresh();
    },
  };
}
