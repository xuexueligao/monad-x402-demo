'use client';
import Link from 'next/link';
import { useAccount } from 'wagmi';
import { ArrowUpRight, Crown, ScrollText, ShieldCheck, Swords, Trophy } from 'lucide-react';
import { ConfigNotice, Footer, Header, LiveStatus } from '@/components/game-ui';
import { useArena } from '@/lib/arena-context';
import { shortAddress } from '@/lib/utils';
import styles from './leaderboard.module.css';

export default function Leaderboard() {
  const { state, connected, error } = useArena();
  const { address } = useAccount();
  const entries = state?.leaderboard || [];
  const myIndex = address ? entries.findIndex(entry => entry.address.toLowerCase() === address.toLowerCase()) : -1;
  const myEntry = myIndex >= 0 ? entries[myIndex] : undefined;

  return <div className={styles.page}>
    <Header active="leaderboard" />
    <main className={styles.main}>
      <div className={styles.titlebar}>
        <div className={styles.title}>
          <Crown size={29} aria-hidden="true" />
          <h1>谁能骗走金币？</h1>
          <span>金币争夺榜</span>
        </div>
        <LiveStatus connected={connected} />
      </div>
      <div className={styles.layout}>
        <aside className={styles.guardian} aria-label="奶龙的挑战邀请">
          <div className={styles.invitation}>
            <span><ShieldCheck size={15} /> 金库守卫 · 奶龙</span>
            <h2>有本事，<br />就把金币拿走。</h2>
            <p>每一场攻防，都值得留下名字。<br />三句话，挑战你的最高战绩。</p>
          </div>
          <div className={styles.dragonScene}>
            <div className={styles.dragonGlow} />
            <img src="/dragon.png" alt="奶龙抱着金币钱袋，守候下一位挑战者" />
          </div>
          <div className={styles.myRecord}>
            <div className={styles.recordHeading}>
              <span><ScrollText size={16} /> 我的战绩</span>
              {address && <small title={address}>{shortAddress(address)}</small>}
            </div>
            {myEntry ? <div className={styles.personalStats}>
              <div><span>当前排名</span><strong><small>#</small>{myIndex + 1}</strong></div>
              <div><span>累计积分</span><strong>{myEntry.score.toLocaleString()}</strong></div>
              <div><span>历史胜场</span><strong>{myEntry.wins}</strong></div>
            </div> : <p>{!address ? '连接钱包，查看属于你的排名。' : !state ? '正在读取你的链上战绩…' : '完成挑战并在链上结算，写下你的第一笔战绩。'}</p>}
            <Link href="/play" className={styles.challengeButton}><Swords size={18} /> 发起我的挑战 <ArrowUpRight size={17} /></Link>
          </div>
        </aside>
        <section className={styles.parchment} aria-labelledby="ranking-title">
          <div className={styles.paperHeading}>
            <div>
              <span className={styles.headingMark}><Trophy size={16} /> 奶龙金库 · 挑战战报</span>
              <h2 id="ranking-title">挑战者荣誉榜</h2>
              <p>每一场攻防，都是你的战绩。排名以链上结算积分为准。</p>
            </div>
            <div className={styles.seal} aria-label="链上结算战绩"><ShieldCheck size={24} /><span>链上结算</span></div>
          </div>
          <div className={styles.summary}>
            <dl><dt>累计挑战</dt><dd>{state ? state.metrics.totalChallenges.toLocaleString() : '—'}<small>场</small></dd></dl>
            <dl><dt>上榜玩家</dt><dd>{state ? entries.length.toLocaleString() : '—'}<small>位</small></dd></dl>
            <p><Crown size={17} /> 靠实力上榜，让金币见证。</p>
          </div>
          <div className={styles.tableScroll} tabIndex={0} role="region" aria-label="挑战者排名明细">
            <table className={styles.table}>
              <thead><tr><th scope="col">排名</th><th scope="col">玩家</th><th scope="col">挑战次数</th><th scope="col">成功次数</th><th scope="col">积分</th><th scope="col">历史胜场</th></tr></thead>
              <tbody>{entries.map((entry, index) => {
                const isYou = address?.toLowerCase() === entry.address.toLowerCase();
                return <tr className={`${index < 3 ? styles.topRank : ''} ${isYou ? styles.isYou : ''}`} key={entry.address}>
                  <td><span className={`${styles.rank} ${index === 0 ? styles.firstRank : ''}`}>{index === 0 ? <><Crown size={19} /><span className={styles.srOnly}>第 1 名</span></> : String(index + 1).padStart(2, '0')}</span></td>
                  <td><div className={styles.player}><span className={styles.playerMark} aria-hidden="true">{index < 3 ? <Trophy size={16} /> : <Swords size={15} />}</span><strong title={entry.address}>{shortAddress(entry.address)}</strong>{isYou && <small>你</small>}</div></td>
                  <td>{entry.attempts}</td>
                  <td>{entry.successes}</td>
                  <td className={styles.score}>{entry.score.toLocaleString()}</td>
                  <td><span className={styles.wins}><Trophy size={13} aria-hidden="true" />{entry.wins}</span></td>
                </tr>;
              })}</tbody>
            </table>
            {!entries.length && <div className={styles.empty}>
              <Crown size={45} strokeWidth={1.2} />
              <h3>{!state ? '正在翻开挑战战报…' : '金币还在，王座空缺。'}</h3>
              <p>{!state ? '链上战绩读取后将在这里展示。' : '完成第一次挑战并在链上结算，成为榜上第一人。'}</p>
              {state && <Link href="/play">去挑战奶龙 <ArrowUpRight size={15} /></Link>}
            </div>}
          </div>
          <div className={styles.paperFoot}><ShieldCheck size={13} /><span>真实攻防，链上留名。</span><span>数据来自链上记录</span></div>
        </section>
      </div>
      <ConfigNotice state={state} error={error} />
    </main>
    <Footer />
  </div>;
}
