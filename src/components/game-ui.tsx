'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { Activity, ArrowUpRight, Check, Coins, Crown, MessageCircle, Shield, Sparkles, Swords, Wallet } from 'lucide-react';
import { WalletButton } from '@/components/wallet-button';
import type { GameEvent, GameSnapshot, LeaderboardEntry } from '@/lib/types';
import { ago, mon, shortAddress } from '@/lib/utils';

export function Header({ active, wallet = true }: { active?: string; wallet?: boolean }) {
  return <header className="site-header"><Link className="brand" href="/" aria-label="MONAD RUG ARENA 首页"><span className="brand-symbol"><span /></span><span>MONAD<span className="brand-sub">RUG ARENA</span></span></Link><nav className="main-nav" aria-label="主导航"><Link className={active === 'play' ? 'active' : ''} href="/play">开始挑战</Link><Link className={active === 'arena' ? 'active' : ''} href="/arena">现场大屏</Link><Link className={active === 'leaderboard' ? 'active' : ''} href="/leaderboard">排行榜</Link></nav><div className="header-actions"><span className="testnet-tag"><i />TESTNET</span>{wallet && <WalletButton compact />}</div></header>;
}

export function Footer() {
  return <footer className="site-footer"><span><span className="tiny-monad" /> Built to play. Powered by Monad.</span><span>仅使用测试网 MON · 聊天无需签名</span><Link href="/arena">打开现场大屏 <ArrowUpRight size={13} /></Link></footer>;
}

export function LiveStatus({ connected }: { connected: boolean }) {
  return <span className={`live-status ${connected ? 'is-live' : ''}`}><i />{connected ? '现场实时同步' : '正在连接竞技场'}</span>;
}

export function ConfigNotice({ state, error }: { state: GameSnapshot | null; error?: string | null }) {
  const issue = error || state?.chainError;
  if (state?.configured && !issue) return null;
  return <div className="config-notice" role="status"><Shield size={17} /><div><strong>{issue ? '竞技场连接暂不可用' : '等待合约部署'}</strong><span>{issue || '合约连接后即可开启挑战，奖池和排名将从链上实时同步。'}</span></div></div>;
}

export function DragonStage({ mood = 'happy', speech, size = 'hero', reactionKey }: { mood?: string; speech?: string; size?: 'hero' | 'arena' | 'play'; reactionKey?: string }) {
  return <div className={`dragon-stage dragon-stage-${size} mood-${mood}`}><div className="stage-halo" /><div className="stage-orbit orbit-one" /><div className="stage-orbit orbit-two" /><div className="stage-platform" /><div className="stage-grid" /><div className="vault-prop" aria-label="小黄龙的金币金库"><div className="vault-face"><Coins size={30} /><span>MON</span><i /><b /></div></div><span className="stage-coin coin-one">✦</span><span className="stage-coin coin-two">✦</span><div key={reactionKey || 'rest'} className={`dragon-wrap ${reactionKey ? 'dragon-react' : ''}`}><img className="dragon-art" src="/dragon.png" alt="黄色身体、绿色大眼睛的小恐龙抱着满满金币的钱袋" /><span className="dragon-spark spark-one">✦</span><span className="dragon-spark spark-two">✧</span></div>{speech && <div className="dragon-speech"><span className="speech-mark">“</span>{speech}</div>}<span className="stage-caption"><Shield size={12} /> 金库守卫 · 小黄龙</span>{mood === 'won' && <div className="victory-burst" aria-label="玩家挑战成功">✦ <Crown size={32} /> ✦</div>}</div>;
}

export function PoolReadout({ wei = '0', large = false, caption = '公共奖池' }: { wei?: string; large?: boolean; caption?: string }) {
  const [display, setDisplay] = useState(wei);
  const last = useRef(wei);
  useEffect(() => {
    const from = BigInt(last.current), to = BigInt(wei); last.current = wei;
    if (from === to || window.matchMedia('(prefers-reduced-motion: reduce)').matches) { setDisplay(wei); return; }
    let frame = 0, started = 0;
    const tick = (time: number) => { if (!started) started = time; const progress = Math.min(1, (time - started) / 650); const fraction = BigInt(Math.round((1 - Math.pow(1 - progress, 3)) * 1000)); setDisplay((from + (to - from) * fraction / 1000n).toString()); if (progress < 1) frame = requestAnimationFrame(tick); };
    frame = requestAnimationFrame(tick); return () => cancelAnimationFrame(frame);
  }, [wei]);
  return <div className={`pool-readout ${large ? 'pool-large' : ''}`}><div className="pool-label"><Coins size={16} />{caption}<span>TESTNET</span></div><div className="pool-amount">{mon(display)}<span>MON</span></div></div>;
}

const eventMeta: Record<string, { label: string; tone: string }> = {
  'player:joined': { label: '玩家加入', tone: 'mint' }, 'challenge:started': { label: '发起挑战', tone: 'purple' }, 'challenge:message': { label: '攻防对话', tone: 'purple' }, 'challenge:resolved': { label: 'AI 判定', tone: 'gold' }, 'chain:submitted': { label: '等待上链', tone: 'purple' }, 'chain:confirmed': { label: '链上已确认', tone: 'mint' }, 'chain:failed': { label: '交易未完成', tone: 'red' }, 'pool:updated': { label: '奖池更新', tone: 'gold' }, 'leaderboard:updated': { label: '排名更新', tone: 'mint' }, 'game:winner': { label: '挑战成功！', tone: 'gold' }, 'round:started': { label: '新回合开启', tone: 'mint' },
};
export function EventFeed({ events, limit = 7 }: { events: GameEvent[]; limit?: number }) {
  return <div className="event-feed" aria-live="polite">{events.length ? events.slice(0, limit).map(event => {
    const meta = eventMeta[event.type] || { label: '竞技场动态', tone: 'purple' }, payload = event.payload || {};
    const player = String(payload.player || payload.address || ''), summary = String(payload.summary || payload.response || payload.message || payload.reason || ''), hash = String(payload.txHash || payload.transactionHash || payload.hash || '');
    return <div className={`event-row tone-${meta.tone}`} key={event.eventId}><span className="event-dot">{event.type === 'chain:confirmed' ? <Check size={12} /> : event.type === 'game:winner' ? <Crown size={12} /> : <Swords size={12} />}</span><div className="event-content"><div className="event-line"><strong>{meta.label}</strong><time>{ago(event.timestamp)}</time></div>{player && <span className="event-player">{shortAddress(player)}</span>}{summary && <p>{summary.slice(0, 105)}</p>}{hash && <Link className="event-tx" href={`/tx/${hash}`}>{shortAddress(hash)} <ArrowUpRight size={11} /></Link>}</div></div>;
  }) : <div className="empty-feed"><Swords size={27} /><strong>第一场攻防，等你开启</strong><p>玩家加入、对话和真实交易<br />都会在这里出现。</p></div>}</div>;
}
export function MiniLeaderboard({ entries, limit = 5 }: { entries: LeaderboardEntry[]; limit?: number }) {
  return <div className="mini-leaderboard">{entries.length ? entries.slice(0, limit).map((entry, index) => <div className={`mini-rank rank-${index + 1}`} key={entry.address}><span className="rank-number">{index === 0 ? <Crown size={19} /> : String(index + 1).padStart(2, '0')}</span><div className="rank-player"><strong>{shortAddress(entry.address)}</strong><span>{entry.attempts} 次挑战 · {entry.successes} 次成功</span></div><div className="rank-score">{entry.score}<small>积分</small></div></div>) : <div className="empty-feed"><Crown size={28} /><strong>王座仍空着</strong><p>完成链上结算后，<br />你的成绩将出现在这里。</p></div>}</div>;
}
export function MetricsBar({ state }: { state: GameSnapshot | null }) {
  const metrics = state?.metrics;
  return <div className="metrics-bar">{[{ icon: Swords, value: metrics?.totalChallenges || 0, name: '累计挑战' }, { icon: Wallet, value: metrics?.activeWallets || 0, name: '活跃钱包' }, { icon: Activity, value: metrics?.confirmedTransactions || 0, name: '交易已确认' }, { icon: MessageCircle, value: metrics?.pendingTransactions || 0, name: '交易确认中' }].map(({ icon: Icon, value, name }) => <div className="metric" key={name}><Icon size={17} /><div><strong>{value.toLocaleString()}</strong><span>{name}</span></div></div>)}</div>;
}
export function RoundBadge({ state }: { state: GameSnapshot | null }) {
  return <span className="round-badge"><Sparkles size={13} />回合 #{state?.round.id || '—'}<span className={state?.round.active ? 'round-active' : ''}>{state?.round.active ? '金库守护中' : state?.configured ? '回合已结束' : '等待开场'}</span></span>;
}
