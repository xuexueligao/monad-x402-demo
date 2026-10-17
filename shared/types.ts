export interface GameEvent<T = Record<string, unknown>> {
  eventId: string;
  type: string;
  timestamp: number;
  roundId: string;
  payload: T;
}
export interface LeaderboardEntry {
  address: string;
  attempts: number;
  successes: number;
  score: number;
  wins: number;
}
export interface GameSnapshot {
  configured: boolean;
  chainId: number;
  contractAddress: string | null;
  aiMode: 'live' | 'local-rules';
  round: {
    id: string;
    prizePool: string;
    challengeFee: string;
    endsAt: number;
    active: boolean;
    winner: string;
    reward: string;
    rewardClaimed: boolean;
  };
  leaderboard: LeaderboardEntry[];
  metrics: {
    totalChallenges: number;
    activeWallets: number;
    confirmedTransactions: number;
    pendingTransactions: number;
  };
  events: GameEvent[];
  joinUrl: string;
  chainError?: string;
}
export interface ChatMessage { role: 'user' | 'assistant'; content: string }
export interface ChallengeResult {
  challengeId: `0x${string}`;
  player: `0x${string}`;
  roundId: string;
  success: boolean;
  score: string;
  deadline: string;
  transcriptHash: `0x${string}`;
}
export interface Attestation { result: ChallengeResult; signature: `0x${string}` }
export interface ChallengeSession {
  id: string;
  token: string;
  player: string;
  roundId: string;
  messages: ChatMessage[];
  expiresAt: number;
  maxMessages: number;
  status: 'active' | 'resolved';
  aiMode: 'live' | 'local-rules';
  result?: { response?: string; result: boolean; reason: string; score: number };
  attestation?: Attestation;
}
