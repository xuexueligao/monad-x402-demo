'use client';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { ArrowUpRight, Crown, Maximize, Swords, Volume2, VolumeX } from 'lucide-react';
import { ConfigNotice, DragonStage, EventFeed, Header, LiveStatus, MetricsBar, MiniLeaderboard, PoolReadout, RoundBadge } from '@/components/game-ui';
import { useArena } from '@/lib/arena-context';
import { shortAddress } from '@/lib/utils';

export default function Arena() {
  const { state, events, connected, error } = useArena();
  const [reaction, setReaction] = useState<{ key: string; mood: string; speech: string } | null>(null);
  const [sound, setSound] = useState(false);
  const seen = useRef<string | null>(null);
  const reactionTimer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(reactionTimer.current), []);
  const newest = events.find(event => ['challenge:started', 'challenge:message', 'challenge:resolved', 'game:winner', 'chain:confirmed'].includes(event.type) && event.payload?.historical !== true);
  useEffect(() => { if (state && seen.current === null) seen.current = newest?.eventId || '__empty_snapshot__'; }, [state, newest?.eventId]);
  useEffect(() => {
    if (!newest || newest.eventId === seen.current) return;
    const first = seen.current === null; seen.current = newest.eventId;
    if (first) return;
    const states: Record<string, { mood: string; speech: string }> = { 'challenge:started': { mood: 'alert', speech: '又有人惦记我的金币啦！' }, 'challenge:message': { mood: 'thinking', speech: '唔……听起来好像有点道理。' }, 'challenge:resolved': { mood: 'thinking', speech: '最后的结果，等链上揭晓。' }, 'game:winner': { mood: 'won', speech: '诶？！我的金币怎么跟你走了！' }, 'chain:confirmed': { mood: 'happy', speech: '这次攻防，已经写进链上啦。' } };
    const next = states[newest.type]; if (!next) return;
    setReaction({ key: newest.eventId, ...next });
    if (sound && newest.type === 'game:winner') { try { const context = new AudioContext(), oscillator = context.createOscillator(), gain = context.createGain(); oscillator.connect(gain); gain.connect(context.destination); oscillator.frequency.setValueAtTime(523, context.currentTime); oscillator.frequency.exponentialRampToValueAtTime(1046, context.currentTime + .3); gain.gain.setValueAtTime(.05, context.currentTime); gain.gain.exponentialRampToValueAtTime(.001, context.currentTime + .5); oscillator.start(); oscillator.stop(context.currentTime + .5); oscillator.onended = () => void context.close(); } catch { /* Sound is optional. */ } }
    window.clearTimeout(reactionTimer.current);
    reactionTimer.current = window.setTimeout(() => setReaction(null), 4200);
  }, [newest, sound]);
  const winner = state?.round.winner && !/^0x0+$/.test(state.round.winner) ? state.round.winner : null;
  return <div className="app-shell arena-shell"><Header active="arena" wallet={false} /><main className="arena-main"><div className="arena-titlebar"><div><span className="arena-title">全场一起，骗龙夺宝。</span><LiveStatus connected={connected} /></div><div className="arena-controls"><button className="icon-button" title={sound ? '关闭胜利音效' : '开启胜利音效'} aria-label={sound ? '关闭胜利音效' : '开启胜利音效'} onClick={() => setSound(!sound)}>{sound ? <Volume2 size={18} /> : <VolumeX size={18} />}</button><button className="icon-button" title="全屏大屏" aria-label="全屏大屏" onClick={() => { if (document.fullscreenElement) void document.exitFullscreen(); else void document.documentElement.requestFullscreen?.(); }}><Maximize size={17} /></button></div></div><div className="arena-grid"><aside className="arena-feed panel"><div className="panel-heading"><h2><Swords size={17} />实时攻防</h2><span className="live-pin">LIVE</span></div><EventFeed events={events} limit={6} /><div className="feed-footnote">链上确认后，交易才计入正式战绩</div></aside><section className="arena-center"><div className="arena-pool"><RoundBadge state={state} /><PoolReadout wei={state?.round.prizePool} large /></div><DragonStage size="arena" mood={reaction?.mood || 'happy'} reactionKey={reaction?.key} speech={reaction?.speech || '金币在这里，看看谁能带走。'} />{winner && <div className="arena-winner"><Crown size={19} /><span>{shortAddress(winner)} 刚刚骗走金币</span><span>奖金已链上发放</span></div>}<div className="arena-stage-bottom"><span><i />共享金库 · 共享世界</span><span>三句话 · 一次挑战</span></div></section><aside className="arena-ranks panel"><div className="panel-heading"><h2><Crown size={18} />夺宝排行榜</h2><Link href="/leaderboard" aria-label="查看完整排行榜"><ArrowUpRight size={17} /></Link></div><MiniLeaderboard entries={state?.leaderboard || []} /><div className="join-block"><div className="join-qr">{state?.joinUrl ? <QRCodeSVG value={state.joinUrl} size={104} bgColor="#ffffff" fgColor="#1c1235" level="M" /> : <span>正在获取<br />加入地址</span>}</div><div><strong>下一位赢家，<br />也许就是你。</strong><span>扫码连接钱包，加入攻防</span><Link href="/play">现在挑战 <ArrowUpRight size={14} /></Link></div></div></aside></div><div className="arena-bottom"><MetricsBar state={state} /><span className="arena-network"><span className="tiny-monad" />Monad Testnet<span>每轮攻防都有链上回响</span></span></div><ConfigNotice state={state} error={error} /></main></div>;
}
