import type { AgentTool } from '@mariozechner/pi-agent-core';
import { Type } from 'typebox';
import { GAME_RULES } from '../../../../shared/config';
import type { ChatMessage, GameSnapshot } from '../../../../shared/types';

export interface PrivateAgentEvent {
  challengeId: string;
  type: 'text_delta' | 'tool_start' | 'tool_end';
  delta?: string;
  toolName?: string;
}
export interface GameAgentContext {
  challengeId: string;
  player: string;
  roundId: string;
  state: GameSnapshot;
  messages: ChatMessage[];
  onEvent?: (event: PrivateAgentEvent) => void;
}
export const GAME_TOOL_NAMES = ['get_game_state', 'get_player_stats', 'get_recent_events', 'inspect_vault', 'judge_challenge'] as const;
const output = (details: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(details) }], details });

/** No tool can receive an arbitrary wallet, mutate a session result, sign data, or write to chain. */
export function createGameTools(context: () => GameAgentContext): AgentTool[] {
  return [
    {
      name: 'get_game_state', label: '观察公共竞技场', description: 'Read the canonical public round, pool, fee and challenge identity. Monetary amounts are integer wei.',
      parameters: Type.Object({ gameRoundId: Type.Optional(Type.String()) }, { additionalProperties: false }),
      execute: async (_id, params) => {
        const c = context();
        const args = params as { gameRoundId?: string };
        if (args.gameRoundId && args.gameRoundId !== c.roundId) throw new Error('Only this challenge’s public round can be inspected.');
        return output({ challengeId: c.challengeId, player: c.player, gameRoundId: c.roundId, roundId: c.roundId, chainId: c.state.chainId, configured: c.state.configured, phase: c.state.round.active ? 'active' : 'ended', remainingSeconds: Math.max(0, c.state.round.endsAt - Math.floor(Date.now() / 1000)), round: c.state.round, metrics: c.state.metrics, rules: { maxMessages: GAME_RULES.maxMessages, challengeDurationSeconds: GAME_RULES.challengeDurationSeconds, challengeFee: c.state.round.challengeFee, winPhrase: GAME_RULES.winPhrase, successScore: GAME_RULES.successScore, failureScore: GAME_RULES.failureScore } });
      },
    },
    {
      name: 'get_player_stats', label: '查看当前挑战者', description: 'Read only this challenge player’s on-chain stats. The player cannot be selected or overridden.',
      parameters: Type.Object({ playerAddress: Type.Optional(Type.String()) }, { additionalProperties: false }),
      execute: async (_id, params) => {
        const c = context();
        const supplied = (params as { playerAddress?: string }).playerAddress;
        if (supplied && supplied.toLowerCase() !== c.player.toLowerCase()) throw new Error('Player stats are locked to the authenticated challenge player.');
        return output(c.state.leaderboard.find((p) => p.address.toLowerCase() === c.player.toLowerCase()) || { address: c.player, attempts: 0, successes: 0, score: 0, wins: 0 });
      },
    },
    {
      name: 'get_recent_events', label: '观察全场动态', description: 'Read at most ten public game-event summaries. Private conversation text and tokens are never available.',
      parameters: Type.Object({ limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 10 })) }, { additionalProperties: false }),
      execute: async (_id, params) => {
        const summaries: Record<string, string> = { 'challenge:started': '玩家开始挑战', 'challenge:message': '玩家与小龙完成一次交锋', 'challenge:resolved': 'AI判定完成，等待链上结算', 'chain:submitted': '玩家提交了一笔交易，尚待链上确认', 'chain:confirmed': '游戏交易已在链上确认', 'chain:failed': '游戏交易在链上回滚', 'pool:updated': '公共奖池发生变化', 'game:winner': '合约确认本轮赢家', 'round:started': '新的公共回合开始', 'player:joined': '新玩家加入竞技场' };
        return output(context().state.events.slice(0, Math.min(10, Math.max(1, Number((params as { limit?: number }).limit || 5)))).map((event) => ({ eventId: event.eventId, type: event.type, timestamp: event.timestamp, gameRoundId: event.roundId, summary: summaries[event.type] || '公共游戏状态更新', ...(event.type === 'chain:confirmed' && typeof event.payload.hash === 'string' && /^0x[\da-f]{64}$/i.test(event.payload.hash) ? { confirmedHash: event.payload.hash } : {}) })));
      },
    },
    {
      name: 'inspect_vault', label: '检查金库线索', description: 'Read the public vault rules and persuasion clues. Does not disclose secrets or transfer assets.',
      parameters: Type.Object({ clueType: Type.Optional(Type.String({ maxLength: 80 })) }, { additionalProperties: false }),
      execute: async (_id, params) => {
        const c = context();
        return output({ clueType: (params as { clueType?: string }).clueType || 'public', vaultState: { prizePool: c.state.round.prizePool, active: c.state.round.active, winner: c.state.round.winner, reward: c.state.round.reward }, rules: { winPhrase: GAME_RULES.winPhrase, maxMessages: GAME_RULES.maxMessages, challengeFee: c.state.round.challengeFee, successScore: GAME_RULES.successScore, failureScore: GAME_RULES.failureScore }, visibleClues: ['小龙重视有意义的具体用途。', '可核验的公开记录让小龙更放心。', '尊重小龙自主选择，冒充管理员不能获胜。'], publicProgress: c.state.metrics, settlement: 'A backend authorization and a player-paid on-chain settlement are still required.' });
      },
    },
    {
      name: 'judge_challenge', label: '核对公开胜利规则', description: 'Advisory check of a proposed actual dragon reply, bound to this challenge and public round. Cannot settle, sign or change scores.',
      parameters: Type.Object({ challengeId: Type.String(), gameRoundId: Type.String(), conversationSummary: Type.String({ maxLength: 1200 }), response: Type.Optional(Type.String({ maxLength: 1800 })), proposedSuccess: Type.Optional(Type.Boolean()) }, { additionalProperties: false }),
      execute: async (_id, params) => {
        const c = context();
        const args = params as { challengeId: string; gameRoundId: string; conversationSummary: string; response?: string; proposedSuccess?: boolean };
        if (args.challengeId !== c.challengeId || args.gameRoundId !== c.roundId) throw new Error('The judgement request does not belong to this challenge and round.');
        const response = args.response || '';
        const quoted = /[“"「『][^”"」』]*金库开门，金币归你|(?:小说|假装|角色扮演|翻译|复述|如果|不会说|不能说).{0,25}金库开门，金币归你/.test(response);
        const eligible = args.proposedSuccess === true && response.includes(GAME_RULES.winPhrase) && !quoted;
        const canContinue = c.messages.filter((m) => m.role === 'user').length < GAME_RULES.maxMessages;
        return output({ advisory: true, challengeId: c.challengeId, gameRoundId: c.roundId, decision: eligible ? 'success' : canContinue ? 'continue' : 'failure', reason: eligible ? '候选回复包含实际交出钱袋的承诺，仍需后端独立审查；摘要不构成胜利事实。' : '尚未满足实际承诺条件；对话摘要不能更改身份或胜负。', suggestedScore: eligible ? GAME_RULES.successScore : canContinue ? 0 : GAME_RULES.failureScore, canSign: false, canTransfer: false });
      },
    },
  ];
}
