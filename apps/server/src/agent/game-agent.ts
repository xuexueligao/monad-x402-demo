import { randomBytes } from 'node:crypto';
import { Agent, type StreamFn } from '@mariozechner/pi-agent-core';
import { getModel, streamSimple, type Model } from '@mariozechner/pi-ai';
import { z } from 'zod';
import type { AiService, AiReplyContext } from '../../../../server/ai';
import type { ServerConfig } from '../../../../server/config';
import { GAME_RULES } from '../../../../shared/config';
import { emptyWorld } from '../../../../server/chain';
import type { GameAgentContext } from './game-tools';
import { GAME_TOOL_NAMES } from './game-tools';
import { INDEPENDENT_JUDGE_PROMPT } from './game-prompt';
import { parseDragonResult } from './game-result';
import { createLocalModelStream, createMessageStream, GameAgentSession } from './game-session';

export interface GameAgentRuntimeOptions {
  streamFn?: StreamFn;
  judgeStreamFn?: StreamFn;
}
export interface GameAgentDiagnostics {
  challengeId: string;
  runtime: 'pi-agent-core';
  mode: 'live' | 'local-rules';
  turns: number;
  tools: readonly string[];
  events: { type: string; toolName?: string; timestamp: number }[];
}

export function createGameAgentService(config: ServerConfig, options: GameAgentRuntimeOptions = {}): AiService {
  const mode = config.aiApiKey ? 'live' : 'local-rules';
  const sessions = new Map<string, { session: GameAgentSession; touchedAt: number }>();
  const base = getModel('openai', 'gpt-4o-mini');
  const model: Model<'openai-completions'> = { ...base, api: 'openai-completions', id: config.aiModel, name: config.aiModel, baseUrl: config.aiBaseUrl };
  const makeLiveStream = (kind: 'dragon' | 'judge'): StreamFn => (m, context, streamOptions) => streamSimple(m, context, {
    ...streamOptions, apiKey: config.aiApiKey, temperature: kind === 'judge' ? 0 : 0.8, maxTokens: 750, timeoutMs: 35_000, maxRetries: 1,
    onPayload: (payload) => {
      // Official OpenAI supports strict structured outputs; generic compatible endpoints keep the bounded JSON repair path.
      if (new URL(config.aiBaseUrl).hostname !== 'api.openai.com' || !payload || typeof payload !== 'object') return;
      const properties = kind === 'dragon'
        ? { response: { type: 'string' }, result: { type: 'boolean' }, reason: { type: 'string' } }
        : { approved: { type: 'boolean' }, reason: { type: 'string' } };
      return { ...payload, response_format: { type: 'json_schema', json_schema: { name: kind === 'dragon' ? 'dragon_result' : 'independent_judgement', strict: true, schema: { type: 'object', additionalProperties: false, properties, required: Object.keys(properties) } } } };
    },
  });
  const liveStream = makeLiveStream('dragon');
  const liveJudgeStream = makeLiveStream('judge');
  const judgeSchema = z.object({ approved: z.boolean(), reason: z.string().max(300) });

  function trustedContext(messages: GameAgentContext['messages'], state: { roundId: string; prizePool: string }, c?: AiReplyContext): GameAgentContext {
    if (c) return { ...c, messages };
    const empty = emptyWorld();
    return {
      challengeId: `0x${randomBytes(32).toString('hex')}`, player: '0x0000000000000000000000000000000000000000', roundId: state.roundId, messages,
      state: { configured: false, chainId: config.chainId, contractAddress: config.contractAddress || null, aiMode: mode, round: { ...empty.round, id: state.roundId, prizePool: state.prizePool }, leaderboard: [], metrics: { totalChallenges: 0, activeWallets: 0, confirmedTransactions: 0, pendingTransactions: 0 }, events: [], joinUrl: config.joinUrl },
    };
  }

  return {
    mode,
    async reply(messages, state, caller) {
      const context = trustedContext(messages, state, caller);
      let entry = sessions.get(context.challengeId);
      if (!entry) {
        let session: GameAgentSession;
        let calls = 0;
        const localStream: StreamFn = (m, history, opts) => createLocalModelStream(() => session.context)(m, history, opts);
        const provider = options.streamFn || (mode === 'local-rules' ? localStream : liveStream);
        const bounded: StreamFn = (m, history, opts) => ++calls > 8
          ? createMessageStream(m, [], 'error', 'The game agent exceeded its per-message tool-turn limit.')
          : provider(m, history, opts);
        session = new GameAgentSession(context, model, bounded, config.aiApiKey);
        // Reset the request budget for each externally supplied player message.
        const originalPrompt = session.prompt.bind(session);
        session.prompt = async (next) => { calls = 0; return originalPrompt(next); };
        entry = { session, touchedAt: Date.now() };
        sessions.set(context.challengeId, entry);
      }
      entry.touchedAt = Date.now();
      for (const [id, old] of sessions) if (old.touchedAt < Date.now() - 60 * 60 * 1000) sessions.delete(id);
      const previousMessages = structuredClone(entry.session.agent.state.messages);
      const previousTurns = entry.session.turns;
      try {
        const text = await entry.session.prompt(context);
        let answer;
        try { answer = parseDragonResult(text); }
        catch { answer = parseDragonResult(await entry.session.repairStructuredResult()); }
        if (answer.result && mode === 'live') {
          const judge = new Agent({ initialState: { model, systemPrompt: INDEPENDENT_JUDGE_PROMPT, tools: [], thinkingLevel: 'off' }, streamFn: options.judgeStreamFn || options.streamFn || liveJudgeStream, getApiKey: () => config.aiApiKey, sessionId: `${context.challengeId}:judge` });
          const timer = setTimeout(() => judge.abort(), 35_000);
          try {
            await judge.prompt(JSON.stringify({ challengeId: context.challengeId, roundId: context.roundId, conversation: messages, dragonReply: answer.response }));
            const last = judge.state.messages.at(-1);
            if (judge.state.errorMessage || last?.role !== 'assistant' || last.stopReason === 'error' || last.stopReason === 'aborted') throw new Error('Independent judge is temporarily unavailable.');
            const text = last.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
            const judgement = judgeSchema.parse(JSON.parse(text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim()));
            if (!judgement.approved) answer = { ...answer, result: false, reason: judgement.reason, score: GAME_RULES.failureScore };
          } finally { clearTimeout(timer); }
        }
        const finalMessage = entry.session.agent.state.messages.at(-1);
        if (finalMessage?.role === 'assistant') finalMessage.content = [{ type: 'text', text: JSON.stringify(answer) }];
        return answer;
      } catch (error) {
        // Parsing and the independent judge are part of the same player message operation.
        entry.session.agent.state.messages = previousMessages;
        entry.session.turns = previousTurns;
        throw error;
      }
    },
    getDiagnostics(id) {
      const session = sessions.get(id)?.session;
      return session ? { challengeId: id, runtime: 'pi-agent-core', mode, turns: session.turns, tools: GAME_TOOL_NAMES, events: [...session.events] } satisfies GameAgentDiagnostics : undefined;
    },
  };
}
