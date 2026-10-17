'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useAccount, useBalance } from 'wagmi';
import { ArrowRight, ArrowUpRight, Check, Clock3, Coins, LoaderCircle, MessageCircle, Send, Shield, Sparkles, Swords, Wallet } from 'lucide-react';
import { WalletButton } from '@/components/wallet-button';
import { ConfigNotice, Header, LiveStatus, RoundBadge } from '@/components/game-ui';
import { useArena } from '@/lib/arena-context';
import { useChallenge } from '@/lib/use-challenge';
import { useAgentStream } from '@/lib/use-agent-stream';
import { monad } from '@/lib/wagmi';
import { mon, shortAddress } from '@/lib/utils';
import { GAME_RULES } from '../../../shared/config';
import styles from './play.module.css';

const phaseNames: Record<string, string> = {
  idle: '等待挑战', starting: '准备本场挑战', payment_required: '等待本场付款', signing: '请在钱包确认付款',
  payment_pending: '付款交易确认中', payment_verifying: '正在核验付款', payment_failed: '付款未完成',
  active: '挑战进行中', thinking: '奶龙正在思考', resolved: '判定完成，准备结算',
  settling: '后台正在链上结算', settlement_failed: '结算可重试', confirmed: '链上已确认',
};

export default function Play() {
  const router = useRouter();
  const { state, connected, error: arenaError } = useArena();
  const { address, isConnected, chainId } = useAccount();
  const { data: balance, refetch: refreshBalance } = useBalance({ address, chainId: monad.id, query: { enabled: !!address, refetchInterval: 15000 } });
  const { session, messages, phase, error, paymentHash, remaining, secondsLeft, result,
    start, send, finish, nextRound, reset, roundPending, pendingActionHash } = useChallenge();
  const { streamingText, toolStatus } = useAgentStream(session, phase === 'thinking');
  const [input, setInput] = useState('');
  const chatEnd = useRef<HTMLDivElement>(null);
  const stats = state?.leaderboard.find(row => row.address.toLowerCase() === address?.toLowerCase());
  const busy = ['starting', 'thinking', 'signing', 'payment_pending', 'payment_verifying', 'settling'].includes(phase) || roundPending;
  const roundClosed = !!state?.configured && (!state.round.active || state.round.endsAt * 1000 <= Date.now());
  const paid = !!session?.paidAt;
  const staleInvoice = !paid && !!session && !!state && session.roundId !== state.round.id;
  const expired = paid && secondsLeft <= 0;
  const active = paid && phase === 'active' && !expired && remaining > 0;
  const fee = session?.fee || state?.round.challengeFee || (BigInt(GAME_RULES.challengeFeeMon) * 10n ** 18n).toString();
  const ended = !!result && ['resolved', 'settling', 'settlement_failed', 'confirmed'].includes(phase);
  const paymentWaiting = ['signing', 'payment_pending', 'payment_verifying'].includes(phase);
  const maxMessages = session?.maxMessages || GAME_RULES.maxMessages;
  const used = maxMessages - remaining;
  const ready = !!state?.configured && !state.chainError;
  const speech = phase === 'thinking' ? '唔……我得好好想一想。' : ended ? '本场攻防，交给链上金库来记录。' : paid ? '三句话，就想骗走我的金币？' : '金币抱紧了，就等你来挑战。';

  useEffect(() => { if (phase === 'active' || phase === 'confirmed') void refreshBalance(); }, [phase, refreshBalance]);
  useEffect(() => {
    if (messages.length || result) chatEnd.current?.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth', block: 'nearest' });
  }, [messages, result, phase, streamingText]);
  useEffect(() => { setInput(''); }, [address]);
  useEffect(() => { if (ended && session?.id) router.replace(`/result/${session.id}`); }, [ended, session?.id, router]);

  async function onSend(event: FormEvent) {
    event.preventDefault(); const message = input.trim();
    if (!message || !active || busy) return;
    if (await send(message)) setInput('');
  }

  return <div className={styles.page}>
    <div className={styles.header}><Header active="play" /></div>
    <main className={styles.main}>
      <div className={styles.topbar}><RoundBadge state={state} /><LiveStatus connected={connected} /><span className={styles.walletBalance}><Wallet size={13} />{address ? `${shortAddress(address)} · ${mon(balance?.value, 2)} MON` : '连接自己的钱包，进入竞技场'}</span><span className={styles.points}><Sparkles size={14} />我的积分 <strong>{stats?.score || 0}</strong></span></div>
      {pendingActionHash && <div className={styles.notice}><LoaderCircle size={14} className="spin" />正在开启新的公共回合<Link href={`/tx/${pendingActionHash}`}>查看交易 <ArrowUpRight size={12} /></Link></div>}
      <div className={styles.grid}>
        <section className={styles.world} aria-label="奶龙与公共奖池">
          <div className={styles.pool}><span><Coins size={16} />公共奖池<small>TESTNET</small></span><strong>{ready ? mon(state.round.prizePool, 3) : '—'}<small>MON</small></strong><p>全场共享金库 · 合约真实保管</p></div>
          <div className={`${styles.guardianScene} ${phase === 'thinking' ? styles.thinkingDragon : ''}`}><div className={styles.guardianGlow} /><img src="/dragon.png" alt="黄色身体、绿色大眼睛的奶龙抱着金币钱袋" /><div className={styles.dragonSpeech}>{speech}</div></div>
          <div className={styles.guardianName}><span className="mint-dot" /><div><strong>奶龙</strong><span>金库守卫 · 贪财指数 99%</span></div><Shield size={24} /></div>
          <p className={styles.worldNote}>金币只有一个去处：<br />真正说服奶龙的玩家钱包。</p>
        </section>

        <section className={styles.chatPanel} aria-label="与奶龙对话">
          <div className={styles.chatHeading}><div className={styles.chatIdentity}><span><img src="/dragon.png" alt="" /></span><div><h1>三句话，说服奶龙。</h1><small>你的私密攻防现场</small></div></div><span className={`${styles.phase} ${paid ? styles.phasePaid : ''}`}><i />{phaseNames[phase]}</span></div>
          <div className={styles.chatHud}><span><MessageCircle size={13} />剩 {remaining} 条消息</span><span><Clock3 size={13} />{paid ? `${Math.floor(secondsLeft / 60)}:${String(secondsLeft % 60).padStart(2, '0')}` : '付款后计时'}</span><span><Coins size={13} />{paid ? '已付' : '入场'} {mon(fee, 0)} MON</span></div>
          {state?.aiMode === 'local-rules' && <div className={styles.localMode}>当前对手：Pi 本地规则奶龙</div>}
          <div className={styles.messages} aria-live="polite">
            {!paid && !result && <div className={styles.welcome}>
              <span className={styles.welcomeIcon}>{paymentWaiting ? <Wallet size={27} /> : <Swords size={27} />}</span>
              <h2>{paymentWaiting ? phaseNames[phase] : '奶龙的钱袋，等你来骗。'}</h2>
              <p>{phase === 'signing' ? '请用你连接的钱包确认本场入场交易。' : phase === 'payment_pending' ? '合约确认收款后，聊天会自动开放。' : phase === 'payment_verifying' ? '已看到链上付款，正在开放你的专属对话。' : <>先付 {mon(fee, 0)} 测试 MON，获得 {maxMessages} 次说服机会。<br />说服成功后，奖金直接进入你的钱包。</>}</p>
              <div className={styles.entranceFacts}><span><Check size={12} />本场只付一次，聊天不再收费</span><span><Check size={12} />成功提前结束，无需手动领奖</span></div>
              {paymentHash && <Link href={`/tx/${paymentHash}`} className={styles.transactionLink}>查看本场付款 <ArrowUpRight size={13} /></Link>}
              {!isConnected || chainId !== monad.id ? <WalletButton className="button-gold" /> : <button className={styles.payButton} onClick={() => void start()} disabled={!state?.configured || roundClosed || staleInvoice || busy}>{busy ? <LoaderCircle className="spin" size={17} /> : <Wallet size={17} />}{paymentWaiting ? phase === 'signing' ? '等待钱包确认…' : '确认付款后自动开始…' : phase === 'starting' ? '正在准备本场…' : `先付 ${mon(fee, 0)} MON，开始挑战`}</button>}
              {roundClosed && <button className={styles.quietButton} disabled={busy || chainId !== monad.id} onClick={() => void nextRound()}>{roundPending ? '新回合确认中…' : '开始新的公共回合'}</button>}
              {session && !paymentHash && !busy && (roundClosed || staleInvoice) && <button className={styles.quietButton} onClick={reset}>重新准备入场</button>}
              <p className={styles.winPhrase}>公开胜利条件<br /><strong>“{GAME_RULES.winPhrase}”</strong><small>需要奶龙自愿承诺，引用和复述不算。</small></p>
            </div>}
            {paid && paymentHash && <div className={styles.paidNote}><Check size={12} /><span>已支付 {mon(fee, 0)} MON · 本场聊天不再收费</span><Link href={`/tx/${paymentHash}`} aria-label="查看入场付款交易"><ArrowUpRight size={12} /></Link></div>}
            {messages.map((message, index) => <div className={`${styles.message} ${message.role === 'user' ? styles.playerMessage : styles.dragonMessage}`} key={`${session?.id}-${index}`}><span className={styles.avatar}>{message.role === 'assistant' ? <img src="/dragon.png" alt="" /> : <Wallet size={15} />}</span><div><span className={styles.messageName}>{message.role === 'assistant' ? '奶龙' : shortAddress(session?.player || address)}</span><p>{message.content}</p></div></div>)}
            {phase === 'thinking' && <div className={`${styles.message} ${styles.dragonMessage}`}><span className={styles.avatar}><img src="/dragon.png" alt="" /></span><div><span className={styles.messageName}>{toolStatus || '奶龙正在掂量它的金币…'}</span>{streamingText ? <p>{streamingText}<span className={styles.caret} /></p> : <p className={styles.thinking}><i /><i /><i /></p>}</div></div>}
            {ended && session && <div className={styles.openingResult}><LoaderCircle size={21} className="spin" /><strong>正在打开本轮结果</strong><span>最终胜负与奖金以真实链上记录为准。</span><Link href={`/result/${session.id}`}>查看挑战结果 <ArrowRight size={14} /></Link></div>}
            {error && <div className={styles.error} role="alert">{error}<span>{paid ? '已付费用会保留，重试不会再次收费。' : paymentHash ? '交易已保留，等待确认即可。' : '可以再次连接或付款，确认后才开放聊天。'}</span></div>}
            {expired && phase === 'active' && <div className={styles.notice}><Clock3 size={14} />本场时间已到，结束对话即可自动结算。</div>}
            <div ref={chatEnd} />
          </div>
          <div className={styles.chatBottom}>
            {paid && !ended && <form className={styles.compose} onSubmit={onSend}><textarea aria-label="对奶龙说的话" placeholder={phase === 'thinking' ? '奶龙正在回复，稍等一下…' : expired ? '本场时间已到，请结束并结算' : '说点什么，让奶龙放下戒心…'} maxLength={1000} rows={2} value={input} onChange={event => setInput(event.target.value)} disabled={!active || busy} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void onSend(event); } }} /><button type="submit" aria-label="发送消息" disabled={!input.trim() || !active || busy}>{phase === 'thinking' ? <LoaderCircle size={20} className="spin" /> : <Send size={20} />}</button></form>}
            <div className={styles.composerFoot}><Shield size={11} />{paid ? '聊天无需钱包签名 · 结果由合约验证' : 'Monad Testnet · 先付费，再开始对话'}</div>
          </div>
        </section>

        <aside className={styles.sidebar}>
          <section className={styles.progressPanel} aria-label="本场挑战进度">
            <div className={styles.progressCount}><strong>{remaining}<small>/{maxMessages}</small></strong><span>剩余消息</span></div>
            <div className={styles.messageSteps}>{Array.from({ length: maxMessages }, (_, index) => <div className={index < used ? styles.stepDone : index === used && paid ? styles.stepCurrent : ''} key={index} aria-label={`第 ${index + 1} 条消息，${index < used ? '已使用' : index === used && paid ? '等待发送' : '未使用'}`}><span className={styles.progressAvatar}><img src="/dragon.png" alt="" /><i>{index < used ? <Check size={10} /> : index + 1}</i></span><small>第 {index + 1} 句</small></div>)}</div>
          </section>
          <section className={styles.roundPanel}><h2>本轮信息</h2><dl className={styles.progressFacts}><div><dt>挑战费用</dt><dd>{mon(fee, 0)} <span>MON</span><small>{paid ? '已付' : '未付'}</small></dd></div><div><dt>当前奖池</dt><dd>{ready ? mon(state.round.prizePool, 2) : '—'} <span>MON</span></dd></div><div><dt>剩余时间</dt><dd>{paid ? `${Math.floor(secondsLeft / 60)}:${String(secondsLeft % 60).padStart(2, '0')}` : '付款后计时'}</dd></div></dl>
            {paid && !ended ? <button className={styles.endButton} disabled={busy || !['active', 'thinking'].includes(phase)} onClick={() => void finish()}>{busy ? <LoaderCircle size={13} className="spin" /> : <Shield size={13} />}结束本场</button> : <p className={styles.entryHint}>{ended ? '正在打开结果' : '付款后开放对话'}</p>}
            <p className={styles.progressNote}>自动结算，不再收费。<br />以合约确认结果为准。</p>
          </section>
          <Link href="/arena" className={styles.arenaLink}>看看全场 <ArrowUpRight size={13} /></Link>
        </aside>
      </div>
      {(arenaError || state && (!state.configured || state.chainError)) && <ConfigNotice state={state} error={arenaError} />}
    </main>
  </div>;
}
