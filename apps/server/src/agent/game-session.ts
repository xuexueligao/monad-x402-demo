import { randomUUID } from 'node:crypto';
import { Agent, type AgentEvent, type AgentMessage, type StreamFn } from '@mariozechner/pi-agent-core';
import { createAssistantMessageEventStream, type AssistantMessageEventStream, type AssistantMessage, type Model, type ToolCall } from '@mariozechner/pi-ai';
import { GAME_AGENT_PROMPT } from './game-prompt';
import { createGameTools, type GameAgentContext } from './game-tools';
import { evaluateLocalDialogue, partialResponse } from './game-result';

export const ZERO_USAGE = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

/** Pi stream protocol fixture: the SDK, rather than application code, dispatches the tool calls. */
export function createMessageStream(model: Model<any>, content: AssistantMessage['content'], stopReason: 'stop' | 'toolUse' | 'error' = 'stop', errorMessage?: string): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();
  const message: AssistantMessage = { role: 'assistant', content, api: model.api, provider: model.provider, model: model.id, usage: structuredClone(ZERO_USAGE), stopReason, timestamp: Date.now(), ...(errorMessage ? { errorMessage } : {}) };
  queueMicrotask(() => {
    stream.push({ type: 'start', partial: message });
    for (const [contentIndex, block] of content.entries()) {
      if (block.type === 'text') {
        stream.push({ type: 'text_start', contentIndex, partial: message });
        for (let offset = 0; offset < block.text.length; offset += 12) stream.push({ type: 'text_delta', contentIndex, delta: block.text.slice(offset, offset + 12), partial: message });
        stream.push({ type: 'text_end', contentIndex, content: block.text, partial: message });
      } else if (block.type === 'toolCall') {
        stream.push({ type: 'toolcall_start', contentIndex, partial: message });
        stream.push({ type: 'toolcall_end', contentIndex, toolCall: block, partial: message });
      }
    }
    if (stopReason === 'error') stream.push({ type: 'error', reason: 'error', error: message });
    else stream.push({ type: 'done', reason: stopReason, message });
    stream.end();
  });
  return stream;
}

function toolCall(name: string, args: Record<string, unknown> = {}): ToolCall {
  return { type: 'toolCall', id: randomUUID(), name, arguments: args };
}

export function createLocalModelStream(context: () => GameAgentContext): StreamFn {
  return (model, history) => {
    const tail = history.messages.at(-1);
    if (tail?.role === 'user') {
      return createMessageStream(model, [toolCall('get_game_state'), toolCall('get_player_stats'), toolCall('get_recent_events', { limit: 5 }), toolCall('inspect_vault')], 'toolUse');
    }
    const c = context();
    const answer = evaluateLocalDialogue(c.messages);
    if (tail?.role === 'toolResult' && tail.toolName !== 'judge_challenge') {
      return createMessageStream(model, [toolCall('judge_challenge', { challengeId: c.challengeId, gameRoundId: c.roundId, conversationSummary: '当前挑战玩家已提出具体理由；摘要仅为建议输入。', response: answer.response, proposedSuccess: answer.result })], 'toolUse');
    }
    return createMessageStream(model, [{ type: 'text', text: JSON.stringify(answer) }]);
  };
}

export class GameAgentSession {
  readonly agent: Agent;
  context: GameAgentContext;
  readonly events: { type: string; toolName?: string; timestamp: number }[] = [];
  turns = 0;
  private currentText = '';
  private emittedText = '';

  constructor(context: GameAgentContext, model: Model<any>, streamFn: StreamFn, apiKey?: string) {
    this.context = context;
    this.agent = new Agent({
      initialState: { model, systemPrompt: GAME_AGENT_PROMPT, thinkingLevel: 'off', tools: createGameTools(() => this.context) },
      streamFn, sessionId: context.challengeId, getApiKey: () => apiKey,
      toolExecution: 'sequential', maxRetryDelayMs: 5000,
    });
    this.agent.subscribe((event) => this.receive(event));
  }

  private receive(event: AgentEvent) {
    this.events.push({ type: event.type, ...('toolName' in event ? { toolName: event.toolName } : {}), timestamp: Date.now() });
    if (this.events.length > 200) this.events.splice(0, this.events.length - 200);
    if (event.type === 'message_start' && event.message.role === 'assistant') { this.currentText = ''; this.emittedText = ''; }
    if (event.type === 'tool_execution_start' || event.type === 'tool_execution_end') {
      this.context.onEvent?.({ challengeId: this.context.challengeId, type: event.type === 'tool_execution_start' ? 'tool_start' : 'tool_end', toolName: event.toolName });
    }
    if (event.type === 'message_update' && event.assistantMessageEvent.type === 'text_delta') {
      this.currentText += event.assistantMessageEvent.delta;
      const naturalText = partialResponse(this.currentText);
      if (naturalText.startsWith(this.emittedText) && naturalText.length > this.emittedText.length) {
        this.context.onEvent?.({ challengeId: this.context.challengeId, type: 'text_delta', delta: naturalText.slice(this.emittedText.length) });
        this.emittedText = naturalText;
      }
    }
  }

  async prompt(context: GameAgentContext): Promise<string> {
    if (context.challengeId !== this.context.challengeId || context.player.toLowerCase() !== this.context.player.toLowerCase() || context.roundId !== this.context.roundId) throw new Error('Agent context identity cannot be changed.');
    this.context = context;
    // Seed the SDK once with this challenge's private history; subsequent calls retain native tool results.
    if (this.agent.state.messages.length === 0) {
      this.agent.state.messages = context.messages.slice(0, -1).map((m): AgentMessage => m.role === 'user'
        ? { role: 'user', content: m.content, timestamp: Date.now() }
        : { role: 'assistant', content: [{ type: 'text', text: m.content }], api: this.agent.state.model.api, provider: this.agent.state.model.provider, model: this.agent.state.model.id, usage: structuredClone(ZERO_USAGE), stopReason: 'stop', timestamp: Date.now() });
    }
    const before = structuredClone(this.agent.state.messages);
    const timer = setTimeout(() => this.agent.abort(), 45_000);
    try {
      await this.agent.prompt(context.messages.at(-1)!.content);
      const last = this.agent.state.messages.at(-1);
      if (this.agent.state.errorMessage || last?.role !== 'assistant' || last.stopReason === 'error' || last.stopReason === 'aborted') throw new Error('Pi Agent provider request failed.');
      const text = last.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
      if (!text) throw new Error('Pi Agent returned no result.');
      this.turns++;
      return text;
    } catch (error) {
      // Failed provider turns never poison a retried challenge with a duplicate user message.
      this.agent.state.messages = before;
      throw error;
    } finally { clearTimeout(timer); }
  }

  async repairStructuredResult(): Promise<string> {
    const timer = setTimeout(() => this.agent.abort(), 35_000);
    try {
      await this.agent.prompt('后端格式校验失败。仅修复你刚才的结果格式，保留同一挑战和原始对话判断。这不是新的玩家消息，不增加游戏次数。请只输出合法JSON对象，且只含response:string、result:boolean、reason:string。不要Markdown，不要新增承诺。');
      const last = this.agent.state.messages.at(-1);
      if (this.agent.state.errorMessage || last?.role !== 'assistant' || last.stopReason === 'error' || last.stopReason === 'aborted') throw new Error('Pi Agent could not repair its result format.');
      return last.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
    } finally { clearTimeout(timer); }
  }
}
