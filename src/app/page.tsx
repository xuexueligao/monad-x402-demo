'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { useAccount } from 'wagmi';
import { ArrowUpRight, MessageCircle, Swords, Trophy, Users } from 'lucide-react';
import { WalletButton } from '@/components/wallet-button';
import { ConfigNotice, DragonStage, Footer, Header, LiveStatus, PoolReadout, RoundBadge } from '@/components/game-ui';
import { useArena } from '@/lib/arena-context';
import { mon } from '@/lib/utils';
import { GAME_RULES } from '../../shared/config';

export default function Home() {
  const { state, connected, error } = useArena();
  const { isConnected } = useAccount();
  const router = useRouter();
  useEffect(() => { if (isConnected) router.push('/play'); }, [isConnected, router]);
  return <div className="app-shell landing-shell"><Header wallet={false} /><main className="landing-main"><div className="landing-copy"><div className="landing-live"><LiveStatus connected={connected} /><span><Users size={14} />{state?.metrics.activeWallets || 0} 位玩家在场</span></div><h1>Can You Rug<br />the Raccoon<span className="headline-question">?</span></h1><h2>你能骗走小恐龙的金币吗？</h2><p className="landing-description">它很可爱，也很贪财。<br />你有三句话，让它心甘情愿打开金库。<br />全场同一只龙，同一个真实测试网奖池。</p><div className="landing-cta"><WalletButton className="button-gold hero-connect" /><p><span className="mint-dot" />连接 Monad Testnet 钱包，立即入场</p></div><Link href="/arena" className="watch-link">先去现场大屏看看 <ArrowUpRight size={16} /></Link><div className="how-to-play"><div><MessageCircle size={19} /><span><strong>三句攻防</strong><small>发挥想象，说服守卫</small></span></div><div><Swords size={19} /><span><strong>{state ? mon(state.round.challengeFee, 0) : GAME_RULES.challengeFeeMon} 测试 MON / 轮</strong><small>结束结算时支付</small></span></div><div><Trophy size={19} /><span><strong>链上夺宝</strong><small>规则判定，真实记录</small></span></div></div></div><div className="landing-visual"><div className="landing-round"><RoundBadge state={state} /></div><DragonStage speech="想要我的金币？先说服我呀。" /><div className="hero-pool"><PoolReadout wei={state?.round.prizePool} /><span className="pool-source">全场共享 · 合约保管</span></div></div></main><ConfigNotice state={state} error={error} /><Footer /></div>;
}
