'use client';
import Link from 'next/link';
import { useAccount } from 'wagmi';
import { ArrowUpRight, Crown, Swords, Trophy } from 'lucide-react';
import { ConfigNotice, Footer, Header, LiveStatus } from '@/components/game-ui';
import { useArena } from '@/lib/arena-context';
import { shortAddress } from '@/lib/utils';

export default function Leaderboard() {
  const { state, connected, error } = useArena(), { address } = useAccount(), entries = state?.leaderboard || [];
  return <div className="app-shell"><Header active="leaderboard" /><main className="leaderboard-main"><div className="page-title"><div><span className="title-icon"><Crown size={24} /></span><h1>谁能骗走金币？</h1><p>每一场攻防，都是你的战绩。排名以链上结算积分为准。</p></div><LiveStatus connected={connected} /></div><div className="leaderboard-intro"><div><strong>{state?.metrics.totalChallenges || 0}</strong><span>场已结算挑战</span></div><div><strong>{entries.length}</strong><span>位上榜玩家</span></div><Link href="/play" className="button-gold"><Swords size={17} />发起我的挑战 <ArrowUpRight size={16} /></Link></div><div className="leaderboard-table-wrap panel"><table className="leaderboard-table"><thead><tr><th>排名</th><th>玩家</th><th>挑战次数</th><th>成功次数</th><th>积分</th><th>历史胜场</th></tr></thead><tbody>{entries.map((entry, index) => <tr className={address?.toLowerCase() === entry.address.toLowerCase() ? 'is-you' : ''} key={entry.address}><td><span className={`table-rank rank-${index + 1}`}>{index === 0 ? <Crown size={20} /> : String(index + 1).padStart(2, '0')}</span></td><td><div className="table-player"><span className={`player-avatar avatar-${index % 4}`}>⌁</span><strong>{shortAddress(entry.address)}</strong>{address?.toLowerCase() === entry.address.toLowerCase() && <small>你</small>}</div></td><td>{entry.attempts}</td><td>{entry.successes}</td><td className="score-cell">{entry.score.toLocaleString()}</td><td><Trophy size={13} /> {entry.wins}</td></tr>)}</tbody></table>{!entries.length && <div className="leaderboard-empty"><img src="/dragon.png" alt="抱着金币等你来挑战的小黄龙" /><h2>金币还在，王座空缺。</h2><p>完成第一次挑战并在链上结算，成为榜上第一人。</p><Link href="/play" className="button-gold">去挑战小黄龙 <Swords size={17} /></Link></div>}</div><ConfigNotice state={state} error={error} /></main><Footer /></div>;
}
