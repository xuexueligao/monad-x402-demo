'use client';

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useAccount, useBalance, useConnect, useDisconnect, useSwitchChain, type Connector } from 'wagmi';
import { QRCodeSVG } from 'qrcode.react';
import { ArrowUpRight, Check, ChevronDown, Copy, LoaderCircle, LogOut, RefreshCw, Smartphone, Wallet, X } from 'lucide-react';
import { monad, walletConnectEnabled } from '@/lib/wagmi';
import { getAvailableInjectedWallets, getWalletOpenLinks, walletDisplayName } from '@/lib/wallet-discovery';
import { shortAddress, mon } from '@/lib/utils';

function WalletConnectionDialog({ wallets, walletConnect, checking, busy, error, onClose, onRefresh, onConnect }: {
  wallets: Connector[]; walletConnect?: Connector; checking: boolean; busy: boolean; error: string;
  onClose: () => void; onRefresh: () => void; onConnect: (connector: Connector) => void;
}) {
  const titleId = useId(), descriptionId = useId();
  const panel = useRef<HTMLDivElement>(null);
  const linkInput = useRef<HTMLInputElement>(null);
  const [qrTarget, setQrTarget] = useState<'metamask' | 'trust' | 'gameUrl'>('metamask');
  const [copied, setCopied] = useState('');
  const links = getWalletOpenLinks(window.location.origin);
  const qrLabels = { metamask: 'MetaMask', trust: 'Trust Wallet', gameUrl: '游戏链接' };

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    panel.current?.querySelector<HTMLButtonElement>('button')?.focus();
    const keyboard = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose(); return; }
      if (event.key !== 'Tab' || !panel.current) return;
      const items = [...panel.current.querySelectorAll<HTMLElement>('a[href],button:not([disabled]),input:not([disabled]),[tabindex="0"]')]
        .filter(element => element.getClientRects().length > 0);
      const first = items[0], last = items[items.length - 1];
      if (!first) { event.preventDefault(); panel.current.focus(); return; }
      if (event.shiftKey && (document.activeElement === first || !panel.current.contains(document.activeElement))) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || !panel.current.contains(document.activeElement))) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', keyboard);
    return () => {
      document.removeEventListener('keydown', keyboard);
      document.body.style.overflow = overflow;
      if (previous?.isConnected) previous.focus();
    };
  }, [onClose]);

  const copyGame = async () => {
    try { await navigator.clipboard.writeText(links.gameUrl); setCopied('已复制游戏链接'); }
    catch { linkInput.current?.focus(); linkInput.current?.select(); setCopied('链接已选中，请复制'); }
  };

  return createPortal(<div className="wallet-dialog-backdrop" onPointerDown={event => { if (event.target === event.currentTarget) onClose(); }}>
    <div className="wallet-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={descriptionId} tabIndex={-1} ref={panel}>
      <button className="wallet-dialog-close icon-button" type="button" aria-label="关闭钱包连接" onClick={onClose}><X size={20} /></button>
      <div className="wallet-dialog-heading"><span className="wallet-dragon"><img src="/dragon.png" alt="" /></span><div><h2 id={titleId}>连接你的钱包</h2><p id={descriptionId}>{wallets.length ? '选择已安装的钱包，进入奶龙的竞技场。' : '用手机钱包打开游戏，或安装浏览器钱包。'}</p></div></div>
      <div className="wallet-dialog-network"><span className="mint-dot" />Monad Testnet<span>连接后查看你自己的余额</span></div>
      {wallets.length > 0 && <div className="wallet-installed-list">{wallets.map(connector => <button type="button" key={connector.uid} disabled={busy} onClick={() => onConnect(connector)}><span className="wallet-choice-icon"><Wallet size={19} /></span><span><strong>{walletDisplayName(connector)}</strong><small>已检测到 · 连接并切换测试网</small></span><ArrowUpRight size={17} /></button>)}</div>}
      {walletConnect && <button type="button" className="wallet-connect-option" disabled={busy} onClick={() => onConnect(walletConnect)}><Smartphone size={19} /><span><strong>WalletConnect</strong><small>扫描连接二维码，使用手机钱包</small></span><ArrowUpRight size={17} /></button>}
      <div className="wallet-open-heading"><h3>{wallets.length ? '也可以用手机钱包' : '手机里已经有钱包？'}</h3><span>打开后再点连接</span></div>
      <div className="wallet-open-links"><a href={links.metamask}><span className="wallet-app-mark mark-metamask">M</span><span>在 MetaMask 中打开</span><ArrowUpRight size={16} /></a><a href={links.trust}><span className="wallet-app-mark mark-trust"><Wallet size={16} /></span><span>在 Trust Wallet 中打开</span><ArrowUpRight size={16} /></a></div>
      <div className="wallet-qr-section"><div className="wallet-qr-code"><QRCodeSVG value={links[qrTarget]} size={132} bgColor="#ffffff" fgColor="#211333" level="M" title={`用手机打开${qrLabels[qrTarget]}`} /></div><div className="wallet-qr-copy"><h3>手机扫码，在手机上玩</h3><p>{qrTarget === 'gameUrl' ? '用手机打开游戏，再选择你的钱包。' : `扫码后在 ${qrLabels[qrTarget]} 内打开游戏，再用手机钱包连接。`}</p><div className="wallet-qr-tabs" role="group" aria-label="选择二维码类型">{(['metamask', 'trust', 'gameUrl'] as const).map(target => <button type="button" aria-pressed={qrTarget === target} key={target} onClick={() => setQrTarget(target)}>{qrLabels[target]}</button>)}</div></div></div>
      <div className="wallet-game-link"><label htmlFor={`${titleId}-link`}>游戏链接</label><div><input id={`${titleId}-link`} readOnly ref={linkInput} value={links.gameUrl} onFocus={event => event.currentTarget.select()} /><button type="button" onClick={() => void copyGame()} aria-label="复制游戏链接">{copied ? <Check size={15} /> : <Copy size={15} />}</button></div><span role="status" aria-live="polite">{copied}</span></div>
      <div className="wallet-install-links"><span>还没有钱包？</span><a href="https://metamask.io/download/" target="_blank" rel="noopener noreferrer">安装 MetaMask <ArrowUpRight size={11} /></a><a href="https://trustwallet.com/download" target="_blank" rel="noopener noreferrer">安装 Trust Wallet <ArrowUpRight size={11} /></a></div>
      <button type="button" className="wallet-detect-again" disabled={checking || busy} onClick={onRefresh}>{checking ? <LoaderCircle size={12} className="spin" /> : <RefreshCw size={12} />}{checking ? '正在检测钱包…' : '已安装钱包？重新检测'}</button>
      {error && <p className="wallet-dialog-error" role="alert">{error}</p>}
    </div>
  </div>, document.body);
}

export function WalletButton({ className = '', compact = false, label }: { className?: string; compact?: boolean; label?: string }) {
  const { address, isConnected, chainId } = useAccount();
  const { connectAsync, connectors, isPending } = useConnect();
  const { disconnect } = useDisconnect();
  const { switchChainAsync, isPending: switching } = useSwitchChain();
  const { data: balance } = useBalance({ address, chainId: monad.id, query: { enabled: Boolean(address) && chainId === monad.id, refetchInterval: 15000 } });
  const [open, setOpen] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [installed, setInstalled] = useState<Connector[]>([]);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState('');
  const working = useRef(false);
  const mounted = useRef(true);
  const menu = useRef<HTMLDivElement>(null);
  const menuButton = useRef<HTMLButtonElement>(null);
  const closeDialog = useCallback(() => setDialogOpen(false), []);
  const walletConnectConnector = walletConnectEnabled ? connectors.find(connector => connector.id === 'walletConnect' || connector.type === 'walletConnect') : undefined;

  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { if (isConnected) setDialogOpen(false); }, [isConnected]);
  useEffect(() => {
    if (!open) return;
    const dismiss = (event: PointerEvent) => { if (!menu.current?.contains(event.target as Node)) setOpen(false); };
    const keyboard = (event: KeyboardEvent) => { if (event.key === 'Escape') { setOpen(false); menuButton.current?.focus(); } };
    document.addEventListener('pointerdown', dismiss); document.addEventListener('keydown', keyboard);
    return () => { document.removeEventListener('pointerdown', dismiss); document.removeEventListener('keydown', keyboard); };
  }, [open]);
  useEffect(() => {
    if (!dialogOpen) return;
    let cancelled = false;
    const scan = () => { void getAvailableInjectedWallets(connectors).then(wallets => { if (!cancelled) setInstalled(wallets); }); };
    scan();
    window.addEventListener('ethereum#initialized', scan); window.addEventListener('eip6963:announceProvider', scan);
    window.dispatchEvent(new Event('eip6963:requestProvider'));
    return () => { cancelled = true; window.removeEventListener('ethereum#initialized', scan); window.removeEventListener('eip6963:announceProvider', scan); };
  }, [dialogOpen, connectors]);

  const handleError = (cause: unknown) => {
    const message = cause instanceof Error ? cause.message : String(cause);
    setError(/reject|denied|4001/i.test(message) ? '已取消连接，可以再次点击连接钱包。' : /request.*pending|already.*pending|32002/i.test(message) ? '钱包里已有连接请求，请打开钱包完成。' : /switch|chain/i.test(message) ? '请在钱包中切换到 Monad Testnet 后重试。' : '连接暂未完成，请打开钱包确认后重试。');
  };
  const connectWallet = async (connector: Connector) => {
    if (working.current || isPending) return;
    working.current = true; setError(''); setOpen(false);
    try {
      if (connector.type === 'injected' && !await connector.getProvider()) { setInstalled([]); setDialogOpen(true); return; }
      // The SDK's own WalletConnect modal must be free to manage its focus outside our dialog.
      setDialogOpen(false);
      const connected = await connectAsync({ connector, chainId: monad.id });
      if (connected.chainId !== monad.id) await switchChainAsync({ chainId: monad.id });
    } catch (cause) {
      if (mounted.current) {
        if (/provider.*not found|provider.*could not|ProviderNotFound/i.test(String(cause))) { setInstalled([]); setError(''); setDialogOpen(true); }
        else handleError(cause);
      }
    } finally { working.current = false; }
  };
  const scanWallets = async (autoConnect: boolean) => {
    if (checking || working.current || isPending) return;
    setChecking(true); setError('');
    try {
      window.dispatchEvent(new Event('eip6963:requestProvider'));
      const wallets = await getAvailableInjectedWallets(connectors);
      if (!mounted.current) return;
      setInstalled(wallets);
      if (autoConnect && wallets.length === 1) await connectWallet(wallets[0]);
      else setDialogOpen(true);
    } finally { if (mounted.current) setChecking(false); }
  };

  if (isConnected && address) return <div className={`wallet-control ${compact ? 'wallet-compact' : ''}`} ref={menu}>
    {chainId !== monad.id ? <button className={`button button-gold ${className}`} disabled={switching} onClick={async () => {
      setError(''); try { await switchChainAsync({ chainId: monad.id }); } catch (cause) { handleError(cause); }
    }}>{switching ? '正在切换…' : '切换 Monad Testnet'}</button> : <button ref={menuButton} className={`button button-wallet ${className}`} onClick={() => setOpen(!open)} aria-expanded={open}>
      <span className="status-dot" /><span>{shortAddress(address)}</span>{!compact && <small>{mon(balance?.value, 2)} MON</small>}<ChevronDown size={14} />
    </button>}
    {open && <div className="wallet-menu"><span>已连接 Monad Testnet</span><button onClick={() => { disconnect(); setOpen(false); }}><LogOut size={14} />断开钱包</button></div>}
    {error && <p className="wallet-error" role="alert">{error}</p>}
  </div>;

  return <div className={`wallet-control ${compact ? 'wallet-compact' : ''}`}>
    <button className={`button button-gold ${className}`} disabled={checking || isPending} onClick={() => void scanWallets(true)}><Wallet size={18} />{checking ? '检测钱包…' : isPending ? '连接中…' : label || (compact ? '连接钱包' : '连接 Monad Testnet 钱包')}</button>
    {dialogOpen && <WalletConnectionDialog wallets={installed} walletConnect={walletConnectConnector} checking={checking} busy={isPending} error={error} onClose={closeDialog} onRefresh={() => void scanWallets(false)} onConnect={connector => void connectWallet(connector)} />}
    {error && !dialogOpen && <p className="wallet-error" role="alert">{error}</p>}
  </div>;
}
