'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { Activity, ArrowUpRight, Clock3, Crown, Maximize, ShieldCheck, Sparkles, Swords, Users, Volume2, VolumeX } from 'lucide-react';
import { ConfigNotice, DragonStage, EventFeed, Header, LiveStatus, PoolReadout } from '@/components/game-ui';
import { useArena } from '@/lib/arena-context';
import { mon, shortAddress } from '@/lib/utils';
import styles from './arena.module.css';

type Reaction = { key: string; mood: string; speech: string; winner?: string; hash?: string };
const reactionTypes = new Set(['challenge:started', 'challenge:paid', 'challenge:message', 'challenge:resolved', 'game:winner', 'chain:confirmed']);

function clock(seconds: number) {
  return [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60].map(value => String(value).padStart(2, '0')).join(':');
}

export default function Arena() {
  const { state, events, connected, error } = useArena();
  const [reaction, setReaction] = useState<Reaction | null>(null);
  const [sound, setSound] = useState(false);
  const [now, setNow] = useState<number | null>(null);
  const seen = useRef<Set<string> | null>(null);
  const reactionTimer = useRef<number | undefined>(undefined);
  const lastSoundAt = useRef(0);
  const celebrationUntil = useRef(0);

  useEffect(() => {
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => { window.clearInterval(timer); window.clearTimeout(reactionTimer.current); };
  }, []);

  useEffect(() => {
    if (!state) return;
    // Opening or reconnecting to the screen must not replay its existing history.
    if (seen.current === null) { seen.current = new Set(events.map(event => event.eventId)); return; }
    const fresh = events.filter(event => !seen.current!.has(event.eventId));
    for (const event of fresh) seen.current.add(event.eventId);
    if (seen.current.size > 240) seen.current = new Set(events.map(event => event.eventId));
    const live = fresh.filter(event => reactionTypes.has(event.type) && event.payload?.historical !== true);
    // Confirmation and winner events can arrive in the same React update. A real
    // confirmed winner takes priority so the following pool update cannot hide it.
    const winnerEvent = live.find(event => event.type === 'game:winner' && event.payload.status === 'confirmed' && /^0x[\da-f]{64}$/i.test(String(event.payload.hash || event.payload.transactionHash || '')));
    const newest = winnerEvent || live.find(event => event.type !== 'game:winner');
    if (!newest) return;
    if (!winnerEvent && Date.now() < celebrationUntil.current) return;
    if (winnerEvent) celebrationUntil.current = Date.now() + 6500;
    const reactions: Record<string, Reaction> = {
      'challenge:started': { key: newest.eventId, mood: 'alert', speech: '谁又在打我金币的主意？' },
      'challenge:paid': { key: newest.eventId, mood: 'alert', speech: '挑战收到！奶龙已经抱紧钱袋。' },
      'challenge:message': { key: newest.eventId, mood: 'thinking', speech: '让我想想……这次会被说服吗？' },
      'challenge:resolved': { key: newest.eventId, mood: 'thinking', speech: '答案已经揭晓，等链上确认。' },
      'chain:confirmed': { key: newest.eventId, mood: 'happy', speech: '叮！这场攻防已经记在链上。' },
      'game:winner': { key: newest.eventId, mood: 'won', speech: '诶？！金币真的被你带走啦！', winner: String(newest.payload.player || ''), hash: String(newest.payload.hash || newest.payload.transactionHash || '') },
    };
    setReaction(reactions[newest.type]);
    if (sound && winnerEvent && Date.now() - lastSoundAt.current > 2500) {
      lastSoundAt.current = Date.now();
      try {
        const context = new AudioContext(), oscillator = context.createOscillator(), gain = context.createGain();
        oscillator.connect(gain); gain.connect(context.destination);
        oscillator.frequency.setValueAtTime(523, context.currentTime);
        oscillator.frequency.exponentialRampToValueAtTime(1046, context.currentTime + .3);
        gain.gain.setValueAtTime(.05, context.currentTime);
        gain.gain.exponentialRampToValueAtTime(.001, context.currentTime + .5);
        oscillator.start(); oscillator.stop(context.currentTime + .5);
        oscillator.onended = () => void context.close();
      } catch { /* Sound is optional; on-chain state does not depend on audio. */ }
    }
    window.clearTimeout(reactionTimer.current);
    reactionTimer.current = window.setTimeout(() => setReaction(null), winnerEvent ? 6500 : 4200);
  }, [events, sound, state]);

  const remaining = state?.round.endsAt && now !== null ? Math.max(0, state.round.endsAt - Math.floor(now / 1000)) : null;
  const roundEnded = !!state?.configured && (state.round.active === false || remaining === 0);
  const isWinning = reaction?.mood === 'won';
  const isAttacking = !!reaction && ['alert', 'thinking'].includes(reaction.mood);
  const stageStatus = isWinning ? '有玩家成功带走金币！' : roundEnded ? '等待下一公共回合开启' : isAttacking ? '有人正在挑战金库' : '奶龙正在守护金币';
  const statusClass = isWinning ? styles.statusWon : isAttacking ? styles.statusAttack : '';
  const feedEvents = events.map(event => ({ ...event, payload: Object.fromEntries(Object.entries(event.payload).map(([key, value]) => [key,
    ['summary', 'response', 'message', 'reason'].includes(key) && typeof value === 'string' ? value.replaceAll('奶龙', '奶龙').replaceAll('奶龙', '奶龙') : value,
  ])) }));

  return <div className={styles.screen}>
    <Header active="arena" />
    <main className={styles.main}>
      <div className={styles.titlebar}>
        <div className={styles.heading}><span className={styles.liveBadge}><i />现场大屏</span><h1>全场一起，挑战奶龙。</h1><LiveStatus connected={connected} /></div>
        <div className={styles.controls}>
          <button title={sound ? '关闭胜利音效' : '开启胜利音效'} aria-label={sound ? '关闭胜利音效' : '开启胜利音效'} aria-pressed={sound} onClick={() => setSound(!sound)}>{sound ? <Volume2 size={18} /> : <VolumeX size={18} />}</button>
          <button title="全屏大屏" aria-label="全屏大屏" onClick={() => { if (document.fullscreenElement) void document.exitFullscreen().catch(() => {}); else void document.documentElement.requestFullscreen?.().catch(() => {}); }}><Maximize size={18} /></button>
        </div>
      </div>

      <div className={styles.layout}>
        <aside className={styles.feedPanel} aria-label="实时公开游戏事件">
          <div className={styles.panelHeading}><h2>实时动态</h2><span className={styles.liveDot}>{connected ? '实时' : '连接中'}</span></div>
          <EventFeed events={feedEvents} limit={6} />
          <div className={styles.feedNote}><ShieldCheck size={13} />链上确认后，战绩才正式生效</div>
        </aside>

        <section className={`${styles.stage} ${isWinning ? styles.celebrating : ''}`} aria-label="共享金库主舞台">
          <div className={styles.pool}>
            <Crown className={styles.poolCrown} size={40} strokeWidth={1.4} fill="currentColor" />
            <PoolReadout wei={state?.round.prizePool} large caption="全场奖池" />
            <div className={styles.roundLabel}><Sparkles size={12} />公共回合 #{state?.round.id || '—'}<span>Monad Testnet</span></div>
          </div>
          <div className={styles.character}>
            <DragonStage size="arena" mood={reaction?.mood || 'happy'} reactionKey={reaction?.key} speech={reaction?.speech || '金币在这里，看你有没有本事带走。'} />
          </div>
          {isWinning && reaction.winner && <div className={styles.winnerBanner} role="status"><Crown size={22} /><div><strong>{shortAddress(reaction.winner)} 夺宝成功</strong><span>奖金已由合约直接发往付款钱包</span></div>{reaction.hash && <Link href={`/tx/${reaction.hash}`} aria-label="查看本次成功发奖交易"><ArrowUpRight size={20} /></Link>}</div>}
          <div className={`${styles.stageStatus} ${statusClass}`}><i />{stageStatus}</div>
          <div className={styles.roundClock}><Clock3 size={15} /><span>{roundEnded ? '本回合已结束' : '下一公共回合倒计时'}</span><strong>{remaining === null ? '—:—:—' : clock(remaining)}</strong><small>{roundEnded ? '主持人可开启新回合' : '当前回合结束后开放'}</small></div>
        </section>

        <aside className={styles.rightWing}>
          <section className={styles.rankingPanel} aria-label="当前前五名玩家">
            <div className={styles.panelHeading}><h2>排行榜</h2><Link href="/leaderboard" aria-label="查看完整排行榜"><span>查看全部</span><ArrowUpRight size={16} /></Link></div>
            <div className={styles.rankList}>{state?.leaderboard.length ? state.leaderboard.slice(0, 5).map((entry, index) => <div className={styles.rankRow} key={entry.address}>
              <span className={`${styles.rankMedal} ${index < 3 ? styles[`medal${index + 1}`] : ''}`}>{index < 3 ? <Crown size={25} fill="currentColor" strokeWidth={1.2} /> : index + 1}</span>
              <span className={styles.avatar} style={{ backgroundColor: ['#69412f', '#646b59', '#73382f', '#4e6247', '#374b56'][index] }} aria-hidden="true">{entry.address.slice(2, 4).toUpperCase()}</span>
              <div className={styles.rankPlayer}><strong>{shortAddress(entry.address)}</strong><span>{entry.attempts} 次挑战 · {entry.successes} 次成功</span></div>
              <div className={styles.rankPoints}>{entry.score.toLocaleString()}<small>积分</small></div>
            </div>) : <div className={styles.emptyRanking}><Crown size={31} /><strong>第一位赢家，会是你吗？</strong><span>完成链上结算，登上排行榜。</span></div>}</div>
          </section>
          <section className={styles.joinPanel} aria-label="扫码加入游戏">
            <div className={styles.qr}>{state?.joinUrl ? <QRCodeSVG value={state.joinUrl} size={118} bgColor="#ffffff" fgColor="#24251f" level="M" /> : <span>正在获取<br />加入地址</span>}</div>
            <div className={styles.joinCopy}><strong>下一位赢家，<br />也许就是你。</strong><span>扫码连接自己的钱包</span><Link href="/play">加入挑战 <ArrowUpRight size={15} /></Link></div>
            <p>{state ? `${mon(state.round.challengeFee, 0)} MON 入场` : '等待游戏配置'}<span>最多 3 条对话 · 成功自动到账</span></p>
          </section>
        </aside>
      </div>

      <footer className={styles.metrics}>
        <div className={styles.metricPanel}><span className={`${styles.metricIcon} ${styles.peopleIcon}`}><Users size={29} /></span><div><span>当前活跃钱包</span><strong>{state ? state.metrics.activeWallets.toLocaleString() : '—'}</strong><small>现场实时连接</small></div></div>
        <div className={styles.metricPanel}><span className={styles.metricIcon}><Activity size={29} /></span><div><span>已确认链上交易</span><strong>{state ? state.metrics.confirmedTransactions.toLocaleString() : '—'}</strong><small>{state ? `${state.metrics.pendingTransactions} 笔等待确认` : '正在同步交易'}</small></div></div>
        <div className={styles.metricPanel}><span className={styles.metricIcon}><Swords size={29} /></span><div><span>累计付费挑战</span><strong>{state ? state.metrics.totalChallenges.toLocaleString() : '—'}</strong><small>每一场都有链上记录</small></div></div>
      </footer>
      <ConfigNotice state={state} error={error} />
    </main>
  </div>;
}
