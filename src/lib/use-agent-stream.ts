'use client';

import { useEffect, useRef, useState } from 'react';
import { io } from 'socket.io-client';
import { API_URL } from './api';
import type { ChallengeSession } from './types';

interface AgentEvent {
  challengeId: string;
  type: 'text_delta' | 'tool_start' | 'tool_end';
  delta?: string;
  toolName?: string;
}

const toolLabels: Record<string, string> = {
  getArenaState: '正在查看公共金库', get_arena_state: '正在查看公共金库',
  getGameState: '正在查看公共金库', get_game_state: '正在查看公共金库',
  getCurrentRound: '正在查看公共回合', get_current_round: '正在查看公共回合',
  getRules: '正在核对游戏规则', get_rules: '正在核对游戏规则',
  getGameRules: '正在核对游戏规则', get_game_rules: '正在核对游戏规则',
  getPlayerStats: '正在查看你的挑战战绩', get_player_stats: '正在查看你的挑战战绩',
  get_recent_events: '正在查看现场的攻防动态',
  inspect_vault: '正在检查金库里的金币',
  judge_challenge: '正在判定本轮攻防结果',
};

/** Authenticated per-challenge stream. Private text never enters the public arena feed. */
export function useAgentStream(session: ChallengeSession | null, thinking: boolean) {
  const [text, setText] = useState('');
  const [toolStatus, setToolStatus] = useState<string | null>(null);
  const active = useRef(thinking);
  active.current = thinking;
  const challengeId = session?.id, token = session?.token;

  useEffect(() => {
    if (thinking) { setText(''); setToolStatus(null); }
    else setToolStatus(null);
  }, [thinking, challengeId]);

  useEffect(() => {
    setText(''); setToolStatus(null);
    if (!challengeId || !token) return;
    const socket = io(API_URL, { transports: ['websocket', 'polling'], reconnectionDelayMax: 4000 });
    socket.on('connect', () => socket.emit('challenge:watch', { challengeId, token }));
    socket.on('agent:event', (event: AgentEvent) => {
      if (!active.current || event.challengeId !== challengeId) return;
      if (event.type === 'text_delta' && typeof event.delta === 'string') {
        setText(previous => previous + event.delta);
      } else if (event.type === 'tool_start') {
        setToolStatus(toolLabels[event.toolName || ''] || '小黄龙正在查看金库记录');
      } else if (event.type === 'tool_end') {
        setToolStatus(null);
      }
    });
    return () => { socket.disconnect(); };
  }, [challengeId, token]);

  // Structured envelopes are not chat content. The backend normally emits response-only deltas.
  const streamingText = /^\s*(?:\{|\[|```)/.test(text) ? '' : text;
  return { streamingText, toolStatus };
}
