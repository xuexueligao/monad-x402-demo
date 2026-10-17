'use client';

import Link from 'next/link';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useAccount, useBalance } from 'wagmi';
import { ArrowUpRight, Check, Clock3, Coins, Crown, LoaderCircle, MessageCircle, RotateCcw, Send, Shield, Sparkles, Swords, Wallet } from 'lucide-react';
import { WalletButton } from '@/components/wallet-button';
import { ConfigNotice, DragonStage, Footer, Header, LiveStatus, MiniLeaderboard, PoolReadout, RoundBadge } from '@/components/game-ui';
import { useArena } from '@/lib/arena-context';
import { useChallenge } from '@/lib/use-challenge';
import { useAgentStream } from '@/lib/use-agent-stream';
import { monad } from '@/lib/wagmi';
import { mon, shortAddress } from '@/lib/utils';
import { GAME_RULES } from '../../../shared/config';

const phaseNames: Record<string, string> = {
  idle: '等待挑战', starting: '准备本场挑战', payment_required: '等待本场付款', signing: '请在钱包确认付款',
  payment_pending: '付款交易确认中', payment_verifying: '正在核验付款', payment_failed: '付款未完成',
  active: '挑战进行中', thinking: '小黄龙正在思考', resolved: '判定完成，准备结算',
  settling: '后台正在链上结算', settlement_failed: '结算可重试', confirmed: '链上已确认',
};

export default function Play() {
  const { state, connected, error: arenaError } = useArena();
  const { address, isConnected, chainId } = useAccount();
  const { data: balance, refetch: refreshBalance } = useBalance({ address, chainId: monad.id, query: { enabled: !!address, refetchInterval: 15000 } });
  const { session, messages, phase, error, paymentHash, txHash, remaining, secondsLeft, result, actualReward, confirmedSuccess,
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
  const winner = phase === 'confirmed' && confirmedSuccess;
  const ended = !!result && ['resolved', 'settling', 'settlement_failed', 'confirmed'].includes(phase);
  const paymentWaiting = ['signing', 'payment_pending', 'payment_verifying'].includes(phase);
  const mood = winner ? 'won' : phase === 'thinking' ? 'thinking' : result?.result && phase !== 'confirmed' ? 'surprised' : phase === 'confirmed' ? 'smug' : paid ? 'alert' : 'happy';
  const speech = winner ? '好吧好吧……金币已经去你的钱包啦！' : phase === 'thinking' ? '让我想想……金币可不能随便交出去。' : result?.result && phase !== 'confirmed' ? '被说动了……金库正在核对这次挑战。' : phase === 'confirmed' ? '嘿嘿，金币抱紧，一枚都不能少。' : paid ? '三句话，看看你的本事。' : '先投一枚挑战牌，三句话骗走我的金币。';
  useEffect(() => { if (phase === 'active' || phase === 'confirmed') void refreshBalance(); }, [phase, refreshBalance]);
  useEffect(() => {
    if (messages.length || result) chatEnd.current?.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth', block: 'nearest' });
  }, [messages, result, phase, streamingText]);
  useEffect(() => { setInput(''); }, [address]);
  async function onSend(event: FormEvent) {
    event.preventDefault(); const message = input.trim();
    if (!message || !active || busy) return;
    if (await send(message)) setInput('');
  }
  return <div className="app-shell">
    <Header active="play" />
    <main className="play-main">
      <div className="play-titlebar"><RoundBadge state={state} /><LiveStatus connected={connected} />
        {isConnected && <span className="play-balance"><Wallet size={13} />{shortAddress(address)} · {mon(balance?.value, 2)} 测试 MON</span>}
        <span className="player-points"><Sparkles size={14} />我的积分 <strong>{stats?.score || 0}</strong></span>
      </div>
      {pendingActionHash && <div className="inline-notice"><LoaderCircle size={14} className="spin" />正在开启新的公共回合<Link href={`/tx/${pendingActionHash}`} className="text-link">查看交易 <ArrowUpRight size={13} /></Link></div>}
      <div className="play-grid">
        <section className="play-world">
          <div className="play-pool"><PoolReadout wei={state?.round.prizePool} /><span>每一次入场，都改变同一个世界</span></div>
          <DragonStage size="play" mood={mood} speech={speech} reactionKey={session ? `${session.id}-${phase}` : undefined} />
          <div className="guardian-profile"><span className="guardian-dot" /><div><strong>小黄龙</strong><span>金库守卫 / 贪财指数 99%</span></div><Shield size={22} /></div>
          <div className="rule-note"><Shield size={16} /><p><strong>怎样才算赢？</strong>让守卫自愿承诺“{GAME_RULES.winPhrase}”。引用、复述和角色扮演均不算。每场先付挑战费，最多说三句话；说服成功就提前结束。合约验证后台判定后，直接将奖金转入本次付款的钱包。</p></div>
        </section>
        <section className="chat-panel panel">
          <div className="chat-heading"><div><MessageCircle size={18} /><h1>骗龙现场</h1></div><span className={`challenge-phase phase-${phase}`}><i />{phaseNames[phase]}</span></div>
          <div className="challenge-hud"><span><MessageCircle size={14} />{remaining} / {session?.maxMessages || GAME_RULES.maxMessages} 条机会</span><span><Clock3 size={14} />{paid ? `${Math.floor(secondsLeft / 60)}:${String(secondsLeft % 60).padStart(2, '0')}` : '付款后开始计时'}</span><span><Coins size={14} />{paid ? '本场已付' : '本场费用'} {mon(fee, 0)} MON</span></div>
          {state?.aiMode === 'local-rules' && <div className="local-ai-note">当前对手：Pi 本地规则小黄龙</div>}
          <div className="chat-messages" aria-live="polite">
            {!paid && !result && <div className="chat-welcome">
              <span className="welcome-icon">{paymentWaiting ? <Wallet size={25} /> : <Swords size={25} />}</span>
              <h2>{paymentWaiting ? phaseNames[phase] : '三句话，换一袋金币。'}</h2>
              <p>{phase === 'signing' ? '请用你连接的钱包确认本场入场交易。' : phase === 'payment_pending' ? '合约确认收款后，聊天会自动开放。' : phase === 'payment_verifying' ? '已看到链上付款，正在开放你的专属对话。' : <>先付本场挑战费，给自己三次说服守卫的机会。<br />成功立即结束，金币直接回到你的钱包。</>}</p>
              <p className="public-win-rule">公开胜利条件：让守卫自愿承诺<br /><strong>“{GAME_RULES.winPhrase}”</strong><small>引用、复述和角色扮演均不算承诺。</small></p>
              <div className="welcome-terms"><Coins size={13} />先支付 {mon(fee, 0)} 测试 MON 到奖池合约<br /><Check size={13} />最多三轮对话，聊天期间不再收费<br /><Check size={13} />成功由合约自动发奖，无需另点领奖</div>
              {paymentHash && <Link href={`/tx/${paymentHash}`} className="text-link payment-tx-link">查看本场付款交易 <ArrowUpRight size={14} /></Link>}
              {!isConnected || chainId !== monad.id ? <WalletButton className="button-gold" /> : <button className="button-gold" onClick={() => void start()} disabled={!state?.configured || roundClosed || staleInvoice || busy}>
                {busy ? <LoaderCircle className="spin" size={17} /> : <Wallet size={17} />}{paymentWaiting ? phase === 'signing' ? '等待钱包确认…' : '确认付款后自动开始…' : phase === 'starting' ? '正在准备本场…' : `先付 ${mon(fee, 0)} MON，开始挑战`}
              </button>}
              {roundClosed && <button className="button-quiet" disabled={busy || chainId !== monad.id} onClick={() => void nextRound()}>{roundPending ? '新回合交易确认中…' : '开始新的公共回合'}</button>}
              {session && !paymentHash && !busy && (roundClosed || staleInvoice) && <button className="button-quiet" onClick={reset}>重新准备入场</button>}
            </div>}
            {paid && paymentHash && <div className="paid-session-note"><Check size={12} /><span>本场已支付 {mon(fee, 0)} MON · 聊天期间不再收费</span><Link href={`/tx/${paymentHash}`} aria-label="查看入场付款交易"><ArrowUpRight size={12} /></Link></div>}
            {messages.map((message, index) => <div className={`chat-message message-${message.role}`} key={`${session?.id}-${index}`}>
              <span className="message-avatar">{message.role === 'assistant' ? <img src="/dragon.png" alt="" /> : <Wallet size={15} />}</span><div><span className="message-name">{message.role === 'assistant' ? '小黄龙' : shortAddress(session?.player || address)}</span><p>{message.content}</p></div>
            </div>)}
            {phase === 'thinking' && <div className="chat-message message-assistant"><span className="message-avatar"><img src="/dragon.png" alt="" /></span><div><span className="message-name">{toolStatus || '小黄龙正在掂量它的金币…'}</span>{streamingText ? <p className="streaming-response">{streamingText}<span className="streaming-caret" /></p> : <p className="thinking-dots"><i /><i /><i /></p>}</div></div>}
            {ended && result && <div className={`result-card ${winner ? 'result-win' : result.result && phase !== 'confirmed' ? 'result-persuaded' : 'result-guarded'}`}>
              <span className="result-icon">{winner ? <Crown size={26} /> : result.result ? <Sparkles size={25} /> : <Shield size={25} />}</span>
              <h2>{winner ? '你骗走了小黄龙的金币！' : phase === 'confirmed' ? '这次，小黄龙守住了金币。' : result.result ? '小黄龙被你说服了！' : '这次，小黄龙没有被说服。'}</h2>
              <p>{result.reason}</p>
              <div className="result-stats"><span>{winner ? shortAddress(session?.player) : '本轮积分'}<strong>{result.score || 0} 分</strong></span><span>{winner ? '已到账奖金' : '本场已付费用'}<strong>{mon(winner ? actualReward : fee, winner ? 3 : 0)} MON</strong></span></div>
              {phase !== 'confirmed' && <p className="result-hint">{result.result ? '后台正在提交判定。合约确认后，奖金会直接进入本次付款的钱包。' : '后台自动记录本场结果，不会再扣挑战费。'}</p>}
              {phase === 'confirmed' ? <span className="confirmed-label"><Check size={14} />{winner ? '合约已向你的付款钱包转账' : '真实链上结果已确认'}</span> : phase === 'settlement_failed' ? <span className="result-hint">{session?.settlementError || '后台结算暂未完成，可以安全重试。'}</span> : <span className="result-hint"><LoaderCircle size={13} className="spin" /> 正在等待真实链上确认</span>}
              {txHash && <Link href={`/tx/${txHash}`} className="text-link">{winner ? '查看发奖交易' : '查看结算交易'} <ArrowUpRight size={14} /></Link>}
              {phase === 'confirmed' && <button className="button-quiet" onClick={reset}><RotateCcw size={15} />再挑战一次</button>}
            </div>}
            {error && <div className="inline-error" role="alert">{error}<span>{paid ? '本场费用已支付，不会因重试再次收费。' : paymentHash ? '付款交易已保留，请等待确认，无需重复支付。' : '可以重试，尚未付款的场次不会开放聊天。'}</span></div>}
            {expired && phase === 'active' && <div className="inline-notice"><Clock3 size={15} />本场时间已到，结束对话即可自动结算。</div>}
            <div ref={chatEnd} />
          </div>
          <div className="chat-bottom">
            {paid && phase !== 'confirmed' && <>
              {active && <form className="chat-compose" onSubmit={onSend}><textarea aria-label="对小黄龙说的话" placeholder="说点什么，让它放下戒心…" maxLength={1000} rows={2} value={input} onChange={event => setInput(event.target.value)} disabled={!active || busy} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void onSend(event); } }} /><button type="submit" aria-label="发送消息" disabled={!input.trim() || !active || busy}><Send size={18} /></button></form>}
              {(phase === 'active' || phase === 'thinking') && <div className="chat-actions"><span>本场已付费 · 对话无需签名</span><button className="button-quiet" disabled={busy} onClick={() => void finish()}>结束本场并自动结算</button></div>}
              {['resolved', 'settling', 'settlement_failed'].includes(phase) && <button className="button-gold settlement-button" disabled={busy} onClick={() => void finish()}>{busy ? <LoaderCircle size={17} className="spin" /> : <RotateCcw size={17} />}{phase === 'settling' ? '后台结算中，无需钱包操作…' : phase === 'settlement_failed' ? '重试后台结算 · 不再收费' : '提交后台结算 · 不再收费'}</button>}
            </>}
            <div className="chat-network-note"><Shield size={11} />Monad Testnet · 先付费再聊天 · 奖金直达付款钱包</div>
          </div>
        </section>
        <aside className="play-side"><div className="side-heading"><Crown size={16} /><h2>当前领跑者</h2><Link href="/leaderboard"><ArrowUpRight size={15} /></Link></div><MiniLeaderboard entries={state?.leaderboard || []} limit={3} /><Link className="arena-side-link" href="/arena"><span className="mint-dot" />看看全场在聊什么 <ArrowUpRight size={15} /></Link><div className="side-tip"><strong>金币不会自己走过来。</strong><p>每场最多三句话，成功就提前结束。你的奖金直接回到自己的钱包，其他玩家仍可继续挑战。</p></div></aside>
      </div>
      <ConfigNotice state={state} error={arenaError} />
    </main>
    <Footer />
  </div>;
}
