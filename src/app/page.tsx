"use client";

import { useEffect, useRef, useState } from "react";
import { createPublicClient, createWalletClient, custom, erc20Abi, formatUnits, http, type Address, type EIP1193Provider } from "viem";
import { monadTestnet } from "viem/chains";
import { x402Client } from "@x402/core/client";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { wrapFetchWithPayment } from "@x402/fetch";
import { TESTNET } from "@/lib/network";

declare global { interface Window { ethereum?: EIP1193Provider } }

type AppConfig = typeof TESTNET & { receiver: string; configured: boolean };
type Stage = "idle" | "connecting" | "ready" | "paying" | "success";
type Premium = { title: string; content: string; unlockedAt: string; network: string };
type Settlement = { success: boolean; transaction: string; network: string; payer?: string };

const reader = createPublicClient({ chain: monadTestnet, transport: http(TESTNET.rpc) });
const short = (value: string) => `${value.slice(0, 6)}…${value.slice(-4)}`;
function decodeHeader<T>(value: string): T {
  return JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(value), c => c.charCodeAt(0)))) as T;
}

export default function Home() {
  const [config, setConfig] = useState<AppConfig>();
  const [stage, setStage] = useState<Stage>("idle");
  const [address, setAddress] = useState<Address>();
  const [balance, setBalance] = useState<string>();
  const [error, setError] = useState("");
  const [premium, setPremium] = useState<Premium>();
  const [settlement, setSettlement] = useState<Settlement>();
  const busy = useRef(false);

  useEffect(() => {
    fetch("/api/config").then(r => {
      if (!r.ok) throw new Error("配置接口暂不可用，请刷新页面。");
      return r.json();
    }).then(setConfig).catch(e => setError(String(e.message)));
  }, []);

  async function refreshBalance(account: Address) {
    try {
      const value = await reader.readContract({ address: TESTNET.usdc, abi: erc20Abi, functionName: "balanceOf", args: [account] });
      setBalance(formatUnits(value, 6));
    } catch { setBalance(undefined); }
  }

  async function connect() {
    if (busy.current) return;
    setError("");
    if (!window.ethereum) {
      setError("当前浏览器没有检测到以太坊钱包。请在安装了 MetaMask 或 Rabby 的浏览器打开此页面，再点击连接钱包。");
      return;
    }
    busy.current = true;
    setStage("connecting");
    try {
      const accounts = await window.ethereum.request({ method: "eth_requestAccounts" }) as Address[];
      if (!accounts[0]) throw new Error("钱包没有返回可用地址，请解锁钱包后重试。");
      await switchToTestnet(window.ethereum);
      setAddress(accounts[0]);
      void refreshBalance(accounts[0]);
      setStage("ready");
    } catch (e) {
      setStage("idle");
      setError(friendlyError(e));
    } finally { busy.current = false; }
  }

  async function pay() {
    if (busy.current || !address || !window.ethereum || !config?.configured) return;
    busy.current = true;
    setError("");
    setStage("paying");
    try {
      await switchToTestnet(window.ethereum);
      const [activeAccount] = await window.ethereum.request({ method: "eth_accounts" }) as Address[];
      if (!activeAccount || activeAccount.toLowerCase() !== address.toLowerCase()) {
        throw new Error("钱包账号已变化，请重新连接钱包。");
      }
      const wallet = createWalletClient({ account: address, chain: monadTestnet, transport: custom(window.ethereum) });
      const client = new x402Client().register(TESTNET.network, new ExactEvmScheme({
        address,
        signTypedData: data => wallet.signTypedData(data),
      }));
      const paymentFetch = wrapFetchWithPayment(fetch, client);
      const response = await paymentFetch("/api/premium", { cache: "no-store" });
      if (!response.ok) {
        const header = response.headers.get("payment-required");
        const reason = header ? decodeHeader<{ error?: string }>(header).error : "";
        throw new Error(reason || `支付未完成（HTTP ${response.status}），请检查测试 USDC 余额后重试。`);
      }
      const receiptHeader = response.headers.get("payment-response");
      if (!receiptHeader) throw new Error("接口没有返回结算凭证，付款状态待核实，请先检查钱包记录。");
      const receipt = decodeHeader<Settlement>(receiptHeader);
      if (!receipt.success || receipt.network !== TESTNET.network || !/^0x[0-9a-fA-F]{64}$/.test(receipt.transaction)) {
        throw new Error("结算凭证不完整，付款状态待核实，请先检查钱包记录。");
      }
      setPremium(await response.json());
      setSettlement(receipt);
      setStage("success");
      void refreshBalance(address);
    } catch (e) {
      setStage("ready");
      setError(friendlyError(e));
    } finally { busy.current = false; }
  }

  const paid = stage === "success";
  return (
    <main className="shell">
      <header className="topbar">
        <a className="wordmark" href="/" aria-label="Monad x402 示例首页"><span className="monad-mark" aria-hidden="true" />Monad <span className="wordmark-sub">付款实验室</span></a>
        <span className="network-tag"><span />仅测试网</span>
      </header>
      <div className="workspace">
        <section className="intro">
          <h1>付一次测试币，<br />解锁一个结果。</h1>
          <p className="lead">先把最小的链上付费流程跑通。连接钱包，用测试 USDC 取得服务端内容，并核验付款记录。</p>
          <ol className="steps" aria-label="付款流程">
            <li className={address ? "done" : "current"}><span className="step-number">1</span><div><strong>连接你的钱包</strong><p>页面会切换到 Monad 测试网。</p></div></li>
            <li className={paid ? "done" : address ? "current" : ""}><span className="step-number">2</span><div><strong>确认 0.001 测试 USDC</strong><p>在钱包中签名，由结算服务提交交易。</p></div></li>
            <li className={paid ? "done" : ""}><span className="step-number">3</span><div><strong>取得内容和付款凭证</strong><p>付款成功后，页面展示服务端返回的结果。</p></div></li>
          </ol>
          <div className="resources"><span>准备测试币</span><a href="https://faucet.circle.com/" target="_blank" rel="noreferrer">领取测试 USDC</a><a href="https://faucet.monad.xyz/" target="_blank" rel="noreferrer">领取测试 MON</a></div>
        </section>

        <section className="receipt" aria-labelledby="receipt-title">
          <div className="receipt-top"><h2 id="receipt-title">第一次 x402 付款</h2><span className={`status ${paid ? "success" : ""}`}>{paid ? "已结算" : stage === "paying" ? "等待结算" : "待付款"}</span></div>
          <div className="price"><span>0.001</span><span className="unit">测试 USDC</span></div>
          <p className="price-caption">一次请求，一次付款。测试币没有真实货币价值。</p>
          <dl className="details"><div><dt>网络</dt><dd>Monad Testnet</dd></div><div><dt>服务</dt><dd>解锁一段示例内容</dd></div><div><dt>付款钱包</dt><dd title={address}>{address ? short(address) : "尚未连接"}</dd></div>{address && <div><dt>测试 USDC 余额</dt><dd>{balance ?? "暂未读到"}</dd></div>}<div><dt>收款地址</dt><dd>{config?.configured ? <a href={`${TESTNET.explorer}/address/${config.receiver}`} target="_blank" rel="noreferrer" title={config.receiver}>{short(config.receiver)}</a> : "等待本地配置"}</dd></div></dl>

          {paid && premium && settlement ? <div className="unlocked" aria-live="polite"><div className="unlocked-label">内容已解锁</div><h3>{premium.title}</h3><p>{premium.content}</p><a className="tx-link" href={`${TESTNET.explorer}/tx/${settlement.transaction}`} target="_blank" rel="noreferrer">在区块浏览器核验这笔付款</a></div> : <div className="locked-content"><span className="lock-icon" aria-hidden="true">⌑</span><div><strong>服务端内容等待解锁</strong><p>支付成功后，结果会出现在这里。</p></div></div>}

          {error && <p className="error" role="alert">{error}</p>}
          {!paid && <button className="primary" type="button" onClick={address ? pay : connect} disabled={stage === "connecting" || stage === "paying" || !config?.configured}>{stage === "connecting" ? "请在钱包中确认连接…" : stage === "paying" ? "请在钱包中签名，等待结算…" : address ? "支付 0.001 测试 USDC 并解锁" : "连接钱包"}</button>}
          {address && stage !== "paying" && <button className="text-button" type="button" onClick={() => { setAddress(undefined); setBalance(undefined); setPremium(undefined); setSettlement(undefined); setStage("idle"); setError(""); }}>重新连接钱包</button>}
          <div className="receipt-bottom"><span>x402 v2</span><span>付款由服务端验证</span></div>
        </section>
      </div>
      <footer><span>付款示例 · Monad Testnet</span><a href="/api/source">下载示例源码</a><a href="https://docs.monad.xyz/guides/x402" target="_blank" rel="noreferrer">查看官方 x402 教程</a></footer>
    </main>
  );
}

async function switchToTestnet(provider: EIP1193Provider) {
  const chainId = `0x${TESTNET.chainId.toString(16)}`;
  try { await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId }] }); }
  catch (e) {
    if ((e as { code?: number }).code !== 4902) throw e;
    await provider.request({ method: "wallet_addEthereumChain", params: [{ chainId, chainName: TESTNET.name, nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 }, rpcUrls: [TESTNET.rpc], blockExplorerUrls: [TESTNET.explorer] }] });
    await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId }] });
  }
}

function friendlyError(error: unknown) {
  const text = error instanceof Error ? error.message : String(error);
  if (/reject|denied|取消|拒绝/i.test(text)) return "你取消了钱包操作，可以准备好后再次尝试。";
  if (/insufficient|balance|funds/i.test(text)) return "测试 USDC 余额不足。请从左侧入口选择 Monad Testnet 领取 USDC，再重试。";
  if (/fetch|network|timeout|timed out/i.test(text)) return "网络或结算服务暂未返回结果。如果已签名，请先检查钱包记录，确认付款状态后再重试。";
  return text;
}
