'use client';

import { createContext, useContext, useEffect, useRef, useState, useCallback, type ReactNode } from 'react';
import { io, type Socket } from 'socket.io-client';
import { useAccount } from 'wagmi';
import { api, API_URL } from './api';
import type { GameEvent, GameSnapshot } from './types';

const ArenaContext = createContext<{
  state: GameSnapshot | null; events: GameEvent[]; connected: boolean; error: string | null;
  refresh: () => Promise<GameSnapshot | null>; reportTransaction: (hash: string, challengeId?: string) => Promise<void>;
}>({ state: null, events: [], connected: false, error: null, refresh: async () => null, reportTransaction: async () => {} });

export function ArenaProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<GameSnapshot | null>(null);
  const [events, setEvents] = useState<GameEvent[]>([]);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const socket = useRef<Socket | null>(null);
  const latest = useRef<GameSnapshot | null>(null);
  const socketRevision = useRef(0);
  const requestRevision = useRef(0);
  const { address } = useAccount();
  const refresh = useCallback(async () => {
    const request = ++requestRevision.current;
    const revision = socketRevision.current;
    try {
      const next = await api<GameSnapshot>('/api/game/state');
      // A slow HTTP response must not overwrite a newer live snapshot or request.
      if (revision !== socketRevision.current || request !== requestRevision.current) return latest.current;
      const sameWorld = latest.current?.contractAddress === next.contractAddress && latest.current?.chainId === next.chainId;
      latest.current = next;
      setState(next);
      setEvents(previous => {
        const merged = new Map([...next.events, ...(sameWorld ? previous : [])].map(event => [event.eventId, event]));
        return [...merged.values()].sort((a, b) => b.timestamp - a.timestamp).slice(0, 60);
      });
      setError(null);
      return next;
    } catch (cause) {
      if (revision === socketRevision.current && request === requestRevision.current) setError(cause instanceof Error ? cause.message : '暂时无法连接竞技场');
      return latest.current;
    }
  }, []);
  useEffect(() => {
    void refresh();
    const client = io(API_URL, { transports: ['websocket', 'polling'], reconnectionDelayMax: 4000 });
    socket.current = client;
    client.on('connect', () => { setConnected(true); void refresh(); });
    client.on('disconnect', () => setConnected(false));
    client.on('snapshot', (snapshot: GameSnapshot) => {
      socketRevision.current += 1;
      latest.current = snapshot;
      setState(snapshot); setEvents([...snapshot.events].sort((a,b) => b.timestamp - a.timestamp).slice(0, 60)); setError(null);
    });
    client.on('game:event', (event: GameEvent) => {
      setEvents(previous => [event, ...previous.filter(item => item.eventId !== event.eventId)].slice(0, 60));
      if (['chain:confirmed', 'pool:updated', 'leaderboard:updated', 'round:started', 'game:winner'].includes(event.type)) void refresh();
    });
    const poll = setInterval(() => void refresh(), 12000);
    return () => { clearInterval(poll); client.disconnect(); socket.current = null; };
  }, [refresh]);
  useEffect(() => {
    const client = socket.current;
    if (!client || !address) return;
    const join = () => client.emit('player:join', { player: address });
    join(); client.on('connect', join);
    return () => { client.off('connect', join); client.emit('player:leave'); };
  }, [address]);
  const reportTransaction = useCallback(async (hash: string, challengeId?: string) => {
    socket.current?.emit('chain:submitted', { hash, challengeId });
    // HTTP tracking still works when the socket is reconnecting, and asks the server to read the actual receipt.
    try {
      await api('/api/transactions/track', { method: 'POST', body: JSON.stringify({ hash, challengeId }) });
      await refresh();
    } catch { /* The submitted hash remains pending locally; receipt polling and the chain indexer continue. */ }
  }, [refresh]);
  return <ArenaContext.Provider value={{ state, events, connected, error, refresh, reportTransaction }}>{children}</ArenaContext.Provider>;
}
export const useArena = () => useContext(ArenaContext);
