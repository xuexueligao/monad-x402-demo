'use client';

import Link from 'next/link';
import { useState } from 'react';
import { ArrowRight, ChevronRight, Coins, Crown, Users, Wallet } from 'lucide-react';
import { ConfigNotice, Header } from '@/components/game-ui';
import { useArena } from '@/lib/arena-context';
import { mon, shortAddress } from '@/lib/utils';
import { GAME_RULES } from '../../shared/config';
import styles from './home.module.css';

const validWinner = (value: unknown): value is string => typeof value === 'string' && /^0x[\da-f]{40}$/i.test(value) && !/^0x0{40}$/i.test(value);

export default function Home() {
  const { state, events, connected, error } = useArena();
  const [showRules, setShowRules] = useState(false);
  const ready = !!state?.configured && !state.chainError;
  const latestWin = events.find(event => event.type === 'game:winner' && validWinner(event.payload.player || event.payload.winner));
  const winner = validWinner(state?.round.winner) ? state.round.winner : latestWin ? String(latestWin.payload.player || latestWin.payload.winner) : null;
  const fee = state?.round.challengeFee ? mon(state.round.challengeFee, 0) : GAME_RULES.challengeFeeMon;

  return <div className={styles.page}>
    <div className={styles.scene} aria-hidden="true" />
    <div className={styles.header}><Header home /></div>
    <main className={styles.hero}>
      <div className={styles.dragonScene} aria-hidden="true"><div className={styles.floorLight} /><div className={styles.dragonShadow} /><img className={styles.dragon} src="/dragon.png" alt="" fetchPriority="high" /></div>
      <section className={styles.copy} aria-labelledby="arena-title">
        <h1 id="arena-title" className={styles.title}><span>骗走</span><span>奶龙的金币</span></h1>
        <p className={styles.description}>用最多 <strong>3 条消息</strong>，<br />说服奶龙交出金币。</p>
        <p className={styles.terms}>每场先付 <strong>{fee} MON</strong> · 成功后合约自动发奖<br />连接你自己的钱包，仅使用 Monad 测试网。</p>
        <div className={styles.actions}>
          <Link className={styles.startButton} href="/play">开始挑战 <ArrowRight size={23} strokeWidth={2} /></Link>
          <button type="button" className={styles.rulesButton} aria-expanded={showRules} aria-controls="how-to-play" onClick={() => setShowRules(value => !value)}>{showRules ? '收起玩法' : '查看玩法'} <ChevronRight size={16} /></button>
        </div>
        <div className={styles.hud} aria-label="竞技场实时数据">
          <div className={`${styles.hudItem} ${styles.poolHud}`}><span className={styles.hudIcon}><Coins size={30} /></span><div><span className={styles.hudLabel}>当前奖池</span><strong className={styles.hudValue}>{ready ? mon(state.round.prizePool, 2) : '—'} <small>MON</small></strong></div></div>
          <div className={styles.hudItem}><span className={`${styles.hudIcon} ${styles.playersIcon}`}><Users size={29} /></span><div><span className={styles.hudLabel}>在线玩家</span><strong className={styles.hudValue}>{state ? state.metrics.activeWallets : '—'}<small className={styles.unit}>人</small></strong></div></div>
          <div className={`${styles.hudItem} ${styles.winnerHud}`}><span className={styles.hudIcon}><Crown size={29} /></span><div><span className={styles.hudLabel}>最近赢家</span><strong className={`${styles.hudValue} ${styles.winnerValue}`}>{winner ? shortAddress(winner) : ready ? '等你来赢' : '—'}</strong></div></div>
        </div>
        <div className={styles.liveNote}><i className={connected ? styles.connected : ''} />{connected ? '全场同一金库 · 链上实时同步' : '正在连接竞技场…'}<span>仅使用测试网 MON</span></div>
        {showRules && <section className={styles.rules} id="how-to-play" aria-label="游戏玩法">
          <div><Wallet size={19} /><span><strong>连接自己的钱包</strong><small>切换 Monad Testnet，确认一次 {fee} MON 入场付款。</small></span></div>
          <div><Users size={19} /><span><strong>三句话，说服奶龙</strong><small>聊天期间不再收费；说服成功就提前结束本场。</small></span></div>
          <div><Coins size={19} /><span><strong>成功，金币自动到账</strong><small>后台提交判定，合约按公开规则向付款钱包发奖。</small></span></div>
          <Link href="/play">准备好了，开始挑战 <ArrowRight size={15} /></Link>
        </section>}
        {(error || state && (!state.configured || state.chainError)) && <div className={styles.notice}><ConfigNotice state={state} error={error} /></div>}
      </section>
    </main>
  </div>;
}
