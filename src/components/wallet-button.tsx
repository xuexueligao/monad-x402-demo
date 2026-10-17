'use client';
import { useState } from 'react';
import { useAccount, useBalance, useConnect, useDisconnect, useSwitchChain } from 'wagmi';
import { Wallet, ChevronDown, LogOut } from 'lucide-react';
import { monad } from '@/lib/wagmi';
import { shortAddress, mon } from '@/lib/utils';

export function WalletButton({ className = '', compact = false }: { className?: string; compact?: boolean }) {
  const { address, isConnected, chainId } = useAccount();
  const { connectAsync, connectors, isPending } = useConnect();
  const { disconnect } = useDisconnect();
  const { switchChainAsync, isPending: switching } = useSwitchChain();
  const { data: balance } = useBalance({ address, chainId: monad.id, query: { enabled: Boolean(address) && chainId === monad.id, refetchInterval: 15000 } });
  const [open, setOpen] = useState(false);
  const [error, setError] = useState('');
  const handleError = (cause: unknown) => {
    const message = cause instanceof Error ? cause.message : String(cause);
    setError(/reject|denied|4001/i.test(message) ? '已取消钱包操作，可以随时重试。' : /provider|not found|connector/i.test(message) ? '请使用 MetaMask / Rabby 钱包浏览器打开，或选择 WalletConnect。' : message.split('\n')[0].slice(0, 140));
  };
  const connectWallet = async (connector: typeof connectors[number]) => {
    setError(''); setOpen(false);
    try { await connectAsync({ connector }); } catch (cause) { handleError(cause); }
  };
  if (isConnected && address) return <div className={`wallet-control ${compact ? 'wallet-compact' : ''}`}>
    {chainId !== monad.id ? <button className={`button button-gold ${className}`} disabled={switching} onClick={async () => {
      setError(''); try { await switchChainAsync({ chainId: monad.id }); } catch (cause) { handleError(cause); }
    }}>{switching ? '正在切换…' : '切换 Monad Testnet'}</button> : <button className={`button button-wallet ${className}`} onClick={() => setOpen(!open)} aria-expanded={open}>
      <span className="status-dot"/><span>{shortAddress(address)}</span>{!compact && <small>{mon(balance?.value, 2)} MON</small>}<ChevronDown size={14}/>
    </button>}
    {open && <div className="wallet-menu"><span>已连接 Monad Testnet</span><button onClick={() => { disconnect(); setOpen(false); }}><LogOut size={14}/>断开钱包</button></div>}
    {error && <p className="wallet-error" role="alert">{error}</p>}
  </div>;
  return <div className={`wallet-control ${compact ? 'wallet-compact' : ''}`}>
    <button className={`button button-gold ${className}`} disabled={isPending} onClick={() => {
      if (connectors.length === 1) void connectWallet(connectors[0]);
      else if (connectors.length > 1) { setError(''); setOpen(!open); }
      else setError('请在 MetaMask / Rabby 钱包浏览器中打开此页面。');
    }}><Wallet size={18}/>{isPending ? '连接中…' : compact ? '连接钱包' : '连接 Monad Testnet 钱包'}</button>
    {open && <div className="wallet-menu">{connectors.map(connector => <button key={connector.uid} onClick={() => void connectWallet(connector)}><Wallet size={16}/>{connector.name === 'Injected' ? '浏览器钱包 · MetaMask / Rabby' : connector.name}</button>)}</div>}
    {error && <p className="wallet-error" role="alert">{error}</p>}
  </div>;
}
