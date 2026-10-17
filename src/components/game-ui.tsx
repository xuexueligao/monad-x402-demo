'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState, type MouseEvent } from 'react';
import { useAccount } from 'wagmi';
import { Activity, ArrowUpRight, Check, Coins, Crown, MessageCircle, Shield, Sparkles, Swords, UserRound, Wallet } from 'lucide-react';
import { WalletButton } from '@/components/wallet-button';
import { useArena } from '@/lib/arena-context';
import { monad } from '@/lib/wagmi';
import type { GameEvent, GameSnapshot, LeaderboardEntry } from '@/lib/types';
import { ago, mon, shortAddress } from '@/lib/utils';

export function Header({ active, wallet = true, home = false }: { active?: string; wallet?: boolean; home?: boolean }) {
  const router = useRouter();
  const { address } = useAccount();
  const { state } = useArena();
  function openMyChallenge(event: MouseEvent<HTMLAnchorElement>) {
    if (!address || !state?.contractAddress) return;
    try {
      const saved = JSON.parse(localStorage.getItem(`rug-arena:prepaid-v1:${monad.id}:${state.contractAddress}:${address.toLowerCase()}`) || '{}');
      const session = saved.session;
      if (session?.player?.toLowerCase() === address.toLowerCase() && /^0x[\da-f]{64}$/i.test(session.id) && ['resolved', 'settling', 'settled', 'settlement_failed'].includes(session.status)) {
        event.preventDefault(); router.push(`/result/${session.id}`);
      }
    } catch { /* A missing local record simply opens the current challenge. */ }
  }
  return <header className="site-header story-header" data-home={home || undefined}><div className="header-brand"><Link className="brand" href="/" aria-label="MONAD RUG ARENA 首页"><span className="brand-symbol"><span /></span><span className="brand-wordmark">MONAD <span>RUG ARENA</span></span></Link><span className="testnet-tag">TESTNET</span></div><nav className="main-nav" aria-label="主导航"><Link className={active === 'play' || home ? 'active' : ''} href="/play" aria-label="Play · 开始挑战">Play</Link><Link className={active === 'result' ? 'active' : ''} href="/play" onClick={openMyChallenge} aria-label="My · 我的挑战">My</Link><Link className={active === 'leaderboard' ? 'active' : ''} href="/leaderboard">Leaderboard</Link><a href="https://github.com/xuexueligao/monad-x402-demo#readme" target="_blank" rel="noopener noreferrer">About</a></nav><div className="header-actions">{wallet && <WalletButton compact label="Connect Wallet" />}<Link className="header-profile" href="/play" onClick={openMyChallenge} aria-label="我的挑战"><UserRound size={24} /></Link></div></header>;
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
  const unconfigured = state && !state.contractAddress;
  const limited = /429|rate.?limit|too many requests|requests?\s+limited|15\s*\/\s*sec/i.test(issue || '');
  const title = unconfigured ? '竞技场尚未开放' : limited ? '链上查询繁忙，正在重试' : issue ? '竞技场连接中断，正在重试' : '正在连接竞技场';
  const message = unconfigured
    ? '游戏合约尚未配置，暂不可开启挑战。已确认的链上记录不受影响。'
    : issue
      ? '暂时无法更新奖池与排名，请等待连接恢复后再开始挑战。已确认的链上记录不受影响。'
      : '正在读取奖池与排名，请稍候。';
  return <div className="config-notice" role="status"><Shield size={17} /><div><strong>{title}</strong><span>{message}</span></div></div>;
}

export function DragonStage({ mood = 'happy', speech, size = 'hero', reactionKey }: { mood?: string; speech?: string; size?: 'hero' | 'arena' | 'play'; reactionKey?: string }) {
  return <div className={`dragon-stage dragon-stage-${size} mood-${mood}`}><div className="stage-halo" /><div className="stage-orbit orbit-one" /><div className="stage-orbit orbit-two" /><div className="stage-platform" /><div className="stage-grid" /><div className="vault-prop" aria-label="奶龙的金币金库"><div className="vault-face"><Coins size={30} /><span>MON</span><i /><b /></div></div><span className="stage-coin coin-one">✦</span><span className="stage-coin coin-two">✦</span><div key={reactionKey || 'rest'} className={`dragon-wrap ${reactionKey ? 'dragon-react' : ''}`}><img className="dragon-art" src="/dragon.png" alt="黄色身体、绿色大眼睛的奶龙抱着满满金币的钱袋" /><span className="dragon-spark spark-one">✦</span><span className="dragon-spark spark-two">✧</span></div>{speech && <div className="dragon-speech"><span className="speech-mark">“</span>{speech}</div>}<span className="stage-caption"><Shield size={12} /> 金库守卫 · 奶龙</span>{mood === 'won' && <div className="victory-burst" aria-label="玩家挑战成功">✦ <Crown size={32} /> ✦</div>}</div>;
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
