'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, type CSSProperties } from 'react';
import { useReadContract } from 'wagmi';
import { ArrowRight, ArrowUpRight, Check, Coins, Copy, Crown, Home, LoaderCircle, RotateCcw, Share2, Shield, Sparkles } from 'lucide-react';
import type { Abi, Address, Hex } from 'viem';
import arenaAbi from '../../contracts/abi/RugArena.json';
import { GAME_RULES } from '../../shared/config';
import { ConfigNotice, Header, MiniLeaderboard } from '@/components/game-ui';
import { useArena } from '@/lib/arena-context';
import { useChallenge } from '@/lib/use-challenge';
import { monad } from '@/lib/wagmi';
import { mon, shortAddress } from '@/lib/utils';
import styles from './challenge-result.module.css';

interface ChainRecord {
  player: Address; roundId: bigint; success: boolean; score: bigint; fee: bigint; reward: bigint;
  transcriptHash: Hex; settledAt: bigint; settled: boolean; enteredAt: bigint; expiresAt: bigint;
}

/** One view for confirmed wins, confirmed losses and an in-flight backend settlement. */
export function ChallengeResultView({ challengeId }: { challengeId: string }) {
  const router = useRouter();
  const { state, events, error: worldError } = useArena();
  const challenge = useChallenge();
  const [shareMessage, setShareMessage] = useState('');
  const validId = /^0x[\da-f]{64}$/i.test(challengeId);
  const current = challenge.session?.id.toLowerCase() === challengeId.toLowerCase();
  const { data, isLoading, error: chainError } = useReadContract({
    address: state?.contractAddress as Address | undefined,
    abi: arenaAbi as Abi,
    functionName: 'getChallenge',
    args: validId ? [challengeId as Hex] : undefined,
    chainId: monad.id,
    query: { enabled: validId && !!state?.configured && !!state.contractAddress, refetchInterval: query => (query.state.data as ChainRecord | undefined)?.settled ? false : 3000 },
  });
  const record = data as ChainRecord | undefined;
  const recorded = !!record && record.enteredAt > 0n;
  const paidKnown = recorded || current && !!challenge.session?.paidAt;
  const confirmed = !!record?.settled || current && challenge.phase === 'confirmed';
  const success = confirmed ? record?.settled ? record.success : challenge.confirmedSuccess : current ? challenge.result?.result : undefined;
  const retryable = current && !confirmed && ['settlement_failed', 'resolved'].includes(challenge.phase);
  const ongoing = current && !confirmed && !challenge.result && challenge.session?.status === 'active';
  const loading = validId && (!state || isLoading);
  const missing = !validId || !!data && !recorded && !current;
  const view = missing ? 'missing' : confirmed ? success ? 'success' : 'failure' : retryable ? 'retry' : 'pending';
  const player = record?.player && recorded ? record.player : current ? challenge.session?.player : undefined;
  const score = confirmed ? record?.settled ? record.score.toString() : String(challenge.result?.score || 0) : null;
  const reward = confirmed ? record?.settled ? record.reward.toString() : challenge.actualReward : null;
  const fee = recorded ? record.fee.toString() : current ? challenge.session?.fee : state?.round.challengeFee;
  const settledEvent = events.find(event => event.type === 'chain:confirmed' && event.payload.action === 'settleChallenge' && String(event.payload.challengeId).toLowerCase() === challengeId.toLowerCase());
  const hash = current && challenge.txHash || settledEvent && String(settledEvent.payload.transactionHash || settledEvent.payload.hash || '');
  const title = missing ? '这场挑战还没有记录。' : loading || !recorded && !current ? '正在翻开本场记录…' : confirmed ? success ? '挑战成功！' : '说服失败' : retryable ? '结果已保留，结算再试一次。' : ongoing ? '你的挑战还在进行。' : success ? '奶龙被你说服了！' : '本场判定，正在上链。';
  const subtitle = missing ? '检查挑战链接，或回到竞技场开启一场新挑战。' : confirmed ? success ? '你成功说服了奶龙！金币已转入付款钱包。' : '奶龙笑出了声，它还是没有交出金币。' : ongoing ? '回到对话，抓住剩下的说服机会。' : '后台负责提交结算；确认后才会显示实际到账奖金。';

  async function shareResult() {
    const url = `${window.location.origin}/result/${challengeId}`;
    try {
      if (navigator.share) await navigator.share({ title: 'MONAD RUG ARENA · 我的挑战战绩', url });
      else { await navigator.clipboard.writeText(url); setShareMessage('战绩链接已复制'); }
    } catch { setShareMessage('可以复制浏览器地址分享这场战绩'); }
  }

  function playAgain() {
    if (current) {
      // A chain read may confirm before the wallet receipt poll; keep the paid session until it catches up.
      if (challenge.phase !== 'confirmed') return;
      challenge.reset();
    }
    router.push('/play');
  }

  return <div className={`${styles.page} ${styles[view]}`}>
    <div className={styles.scene} aria-hidden="true" />
    <div className={styles.shell}><Header active="result" />
      <main className={styles.main}>
        <section className={styles.stage} aria-label="奶龙的挑战结果">
          <span className={styles.stageLabel}>金库守卫 · 奶龙</span>
          {confirmed && success && <Crown className={styles.crown} size={60} aria-label="挑战获胜" />}
          <div className={styles.halo} />
          <img className={styles.dragon} src="/dragon.png" alt="黄色身体、绿色大眼睛、抱着金币钱袋的奶龙" />
          <div className={styles.characterLine}>{confirmed ? success ? '哎呀，真的把金币骗走啦！' : '嘿嘿，金币还是我的！' : '等等，我去核对一下金库…'}</div>
          {confirmed && success && <div className={styles.confetti} aria-hidden="true">{Array.from({ length: 12 }, (_, index) => <i key={index} style={{ '--n': index } as CSSProperties} />)}</div>}
        </section>
        <section className={styles.result} aria-labelledby="result-title" aria-live="polite">
          <div className={styles.resultMark}>{confirmed ? success ? <Crown size={29} /> : <Shield size={29} /> : <LoaderCircle size={28} className="spin" />}<span>{confirmed ? '本场链上结果' : missing ? '挑战记录' : '本场结算进度'}</span><span className={styles.testnet}>TESTNET</span></div>
          <h1 id="result-title">{confirmed && !success ? <>说服<span className={styles.failureWord}>失败</span></> : title}</h1><p className={styles.subtitle}>{subtitle}</p>
          {player && <span className={styles.player}>挑战者 <strong title={player}>{shortAddress(player)}</strong><span>回合 #{recorded ? record.roundId.toString() : challenge.session?.roundId || '—'}</span></span>}
          {!missing && <>
            <div className={styles.numbers}><div className={styles.reward}><span><Coins size={18} />{confirmed ? success ? '获得奖励 · 已到账' : '获得奖励' : '实际到账奖金'}</span><strong>{confirmed && success ? '+' : ''}{reward !== null ? mon(reward, 3) : '等待确认'}{reward !== null && <small> MON</small>}</strong></div>
            <div className={styles.stats}><div><Sparkles size={15} /><span>本场积分</span><strong>{score !== null ? `+${score}` : '待确认'}</strong></div><div><Coins size={15} /><span>{paidKnown ? '已付入场费' : '本场挑战费'}</span><strong>{fee ? `${mon(fee, 0)} MON` : `${GAME_RULES.challengeFeeMon} MON / 场`}</strong></div></div>
            </div>
            <div className={`${styles.receipt} ${confirmed ? styles.confirmed : ''}`}>
              {confirmed ? <Check size={24} /> : <LoaderCircle size={22} className="spin" />}<div><strong>{confirmed ? '交易已确认' : retryable ? '暂未完成，重试不会再收挑战费' : '正在等待真实链上确认'}</strong><span>{hash && /^0x[\da-f]{64}$/i.test(hash) ? shortAddress(hash) : confirmed ? 'Monad Testnet · 链上记录可核验' : '无需再次付款，也无需再签一笔领奖交易'}</span></div>
              {hash && /^0x[\da-f]{64}$/i.test(hash) && <><button className={styles.copyHash} aria-label="复制结算交易哈希" onClick={() => void navigator.clipboard.writeText(hash).then(() => setShareMessage('交易哈希已复制')).catch(() => setShareMessage('请在交易详情复制哈希'))}><Copy size={16} /></button><Link href={`/tx/${hash}`} aria-label="查看本场结算交易">在浏览器中查看 <ArrowUpRight size={17} /></Link></>}
            </div>
          </>}
          {confirmed && !success && <div className={styles.dragonQuote}><span><img src="/dragon.png" alt="奶龙" /></span><div><strong>奶龙</strong><p>哈哈哈哈！还差得远呢！<br />想从我这里拿走金币？下次再来试试吧！</p></div></div>}
          {current && challenge.result?.reason && <p className={styles.reason}>奶龙的判定：{challenge.result.reason}</p>}
          {current && (challenge.error || challenge.session?.settlementError) && <p className={styles.error} role="alert">{challenge.error || challenge.session?.settlementError}</p>}
          {chainError && !confirmed && <p className={styles.error} role="status">暂时无法读取链上记录，正在重新连接。</p>}
          <div className={styles.actions}>
            {retryable ? <button className={styles.primary} onClick={() => void challenge.finish()}><RotateCcw size={17} />重试结算 · 不再收费</button> : ongoing ? <Link className={styles.primary} href="/play">继续本场对话 <ArrowRight size={18} /></Link> : confirmed ? <button className={styles.primary} disabled={current && challenge.phase !== 'confirmed'} onClick={playAgain}>再来一局 <ArrowRight size={18} /></button> : missing ? <Link className={styles.primary} href="/play">回到挑战 <ArrowRight size={18} /></Link> : <span className={styles.waiting}><LoaderCircle className="spin" size={17} />结算确认中</span>}
            {confirmed && (success ? <button className={styles.secondary} onClick={() => void shareResult()}><Share2 size={16} />分享战绩</button> : <Link className={styles.secondary} href="/"><Home size={17} />返回大厅</Link>)}
          </div>
          <span className={styles.shareStatus} role="status">{shareMessage}</span>
          <Link className={styles.arenaLink} href="/arena">去大屏看看全场战况 <ArrowUpRight size={14} /></Link>
        </section>
      </main>
      <section className={styles.standings} aria-label="当前领跑者"><div><Crown size={17} /><h2>金库英雄榜</h2><Link href="/leaderboard">全部战绩 <ArrowUpRight size={13} /></Link></div><MiniLeaderboard entries={state?.leaderboard || []} limit={3} /></section>
      <ConfigNotice state={state} error={worldError} />
    </div>
  </div>;
}
