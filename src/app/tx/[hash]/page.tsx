'use client';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { ArrowLeft, ArrowUpRight, Check, Copy, LoaderCircle, ShieldCheck, X } from 'lucide-react';
import { Footer, Header } from '@/components/game-ui';
import { api } from '@/lib/api';
import { mon, shortAddress } from '@/lib/utils';

interface TransactionData { hash: string; status: string; blockNumber?: string | number | null; from?: string; to?: string; value?: string; gasUsed?: string; effectiveGasPrice?: string; explorerUrl?: string; }

export default function TransactionPage() {
  const { hash } = useParams<{ hash: string }>();
  const [transaction, setTransaction] = useState<TransactionData | null>(null), [error, setError] = useState<string | null>(null), [copied, setCopied] = useState(false);
  useEffect(() => { let stopped = false; const load = async () => { try { const data = await api<TransactionData>(`/api/transactions/${hash}`); if (!stopped) { setTransaction(data); setError(null); } } catch (cause) { if (!stopped) setError(cause instanceof Error ? cause.message : '暂时无法读取交易，请稍后重试。'); } }; void load(); const timer = window.setInterval(() => void load(), 4000); return () => { stopped = true; window.clearInterval(timer); }; }, [hash]);
  const confirmed = transaction?.status === 'success', failed = transaction?.status === 'reverted';
  const unavailable = !!error && !transaction;
  const statusLabel = confirmed ? '已确认' : failed ? '失败' : transaction?.status === 'pending' ? '等待确认' : unavailable ? '暂时无法读取' : '正在读取';
  return <div className="app-shell"><Header /><main className="tx-main"><Link href="/play" className="back-link"><ArrowLeft size={15} />回到游戏</Link><div className="tx-heading"><span className={`tx-status-icon ${confirmed ? 'tx-success' : failed ? 'tx-failed' : ''}`}>{confirmed ? <ShieldCheck size={36} /> : failed ? <X size={34} /> : <LoaderCircle size={32} className="spin" />}</span><span className="testnet-tag"><i />MONAD TESTNET</span><h1>{confirmed ? '攻防记录，已写入链上。' : failed ? '这笔交易没有完成。' : unavailable ? '暂时无法读取这笔交易。' : '正在核对链上交易。'}</h1><p>{confirmed ? '这是一笔真实的 Monad Testnet 交易。' : failed ? '回到游戏后，可以重新尝试结算。' : '交易状态直接从链上读取，确认后自动更新。'}</p></div><section className="transaction-panel panel"><div className="panel-heading"><h2>交易详情</h2><span className={`receipt-status ${confirmed ? 'receipt-confirmed' : failed ? 'receipt-failed' : ''}`}>{statusLabel}</span></div><dl className="transaction-details"><div className="hash-detail"><dt>交易哈希</dt><dd><code>{hash}</code><button className="icon-button" aria-label="复制交易哈希" onClick={async () => { await navigator.clipboard.writeText(hash); setCopied(true); window.setTimeout(() => setCopied(false), 1800); }}>{copied ? <Check size={16} /> : <Copy size={16} />}</button></dd></div><div><dt>区块高度</dt><dd>{transaction?.blockNumber ? `#${Number(transaction.blockNumber).toLocaleString()}` : unavailable ? '—' : '等待出块'}</dd></div><div><dt>发送方</dt><dd>{transaction?.from ? <code title={transaction.from}>{shortAddress(transaction.from)}</code> : '读取中'}</dd></div><div><dt>游戏合约</dt><dd>{transaction?.to ? <code title={transaction.to}>{shortAddress(transaction.to)}</code> : '读取中'}</dd></div><div><dt>交易金额</dt><dd className="tx-value">{transaction?.value !== undefined ? `${mon(transaction.value)} MON` : '读取中'}</dd></div><div><dt>Gas 消耗</dt><dd>{transaction?.gasUsed ? Number(transaction.gasUsed).toLocaleString() : '等待确认'}</dd></div><div><dt>网络</dt><dd>Monad Testnet</dd></div></dl>{error && <div className="inline-error" role="alert">{error}</div>}{transaction?.explorerUrl && <a className="button-gold" href={transaction.explorerUrl} target="_blank" rel="noreferrer">在区块浏览器中查看 <ArrowUpRight size={16} /></a>}</section></main><Footer /></div>;
}
