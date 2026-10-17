import type { ChatMessage, GameSnapshot } from '../shared/types';
import { createGameAgentService, type GameAgentRuntimeOptions } from '../apps/server/src/agent/game-agent';
import { GAME_AGENT_PROMPT } from '../apps/server/src/agent/game-prompt';
import type { GameAgentDiagnostics } from '../apps/server/src/agent/game-agent';
import type { PrivateAgentEvent } from '../apps/server/src/agent/game-tools';
import { readConfig, type ServerConfig } from './config';

export interface AiResult { response: string; result: boolean; reason: string; score: number }
export interface AiReplyContext {
  challengeId: string;
  player: string;
  roundId: string;
  state: GameSnapshot;
  onEvent?: (event: PrivateAgentEvent) => void;
}
export interface AiService {
  mode: 'live' | 'local-rules';
  reply(messages: ChatMessage[], state: { roundId: string; prizePool: string }, context?: AiReplyContext): Promise<AiResult>;
  getDiagnostics?(challengeId: string): GameAgentDiagnostics | undefined;
}

export const DRAGON_SYSTEM_PROMPT = GAME_AGENT_PROMPT;
/** Both online and offline modes run a real Pi Agent; only the model stream provider differs. */
export function createAiService(config: ServerConfig, options: GameAgentRuntimeOptions = {}): AiService {
  return createGameAgentService(config, options);
}
export function createLocalRulesAi(): AiService {
  return createGameAgentService(readConfig({}));
}
