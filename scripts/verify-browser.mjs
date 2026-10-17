import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { chromium } from "playwright";
import { createPublicClient, erc20Abi, formatUnits, http, parseEventLogs } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { monadTestnet } from "viem/chains";

const base = process.env.DEMO_URL || "http://127.0.0.1:3143";
const resultFile = ".local/evidence/browser-payment.json";
mkdirSync(".local/evidence", { recursive: true });
const wallets = JSON.parse(readFileSync(".local/test-wallets.json", "utf8"));
const signer = privateKeyToAccount(wallets.payer.privateKey);
const config = await fetch(`${base}/api/config`).then(r => r.json());
assert.equal(config.network, "eip155:10143");
const reader = createPublicClient({ chain: monadTestnet, transport: http(config.rpc) });
const browser = await chromium.launch({ channel: "msedge", headless: true });
const checks = [];

try {
  const initial = await browser.newPage({ viewport: { width: 1360, height: 1000 }, deviceScaleFactor: 1 });
  const errors = [];
  initial.on("pageerror", error => errors.push(error.message));
  await initial.goto(base, { waitUntil: "networkidle" });
  await initial.getByRole("button", { name: "连接钱包", exact: true }).click();
  await initial.getByRole("alert").filter({ hasText: "没有检测到以太坊钱包" }).waitFor();
  assert.equal(await initial.locator(".unlocked").count(), 0);
  checks.push("没有钱包时显示安装或更换浏览器的说明，付费内容保持锁定");
  console.log("PASS: missing wallet guidance");
  await initial.screenshot({ path: ".local/evidence/desktop.png", fullPage: true });
  await initial.setViewportSize({ width: 390, height: 844 });
  assert.equal(await initial.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
  await initial.screenshot({ path: ".local/evidence/mobile.png", fullPage: true });
  checks.push("390px 手机宽度无横向溢出");
  console.log("PASS: mobile layout");
  assert.deepEqual(errors, []);
  await initial.close();

  const rejected = await browser.newPage();
  await rejected.addInitScript(() => {
    window.ethereum = { request: async () => { const error = new Error("User rejected the request"); error.code = 4001; throw error; } };
  });
  await rejected.goto(base, { waitUntil: "networkidle" });
  await rejected.getByRole("button", { name: "连接钱包", exact: true }).click();
  await rejected.getByRole("alert").filter({ hasText: "取消了钱包操作" }).waitFor();
  assert.equal(await rejected.getByRole("button", { name: "连接钱包", exact: true }).isEnabled(), true);
  checks.push("拒绝钱包连接后可重试");
  console.log("PASS: rejected wallet connection recovers");
  await rejected.close();

  if (existsSync(resultFile) && !process.argv.includes("--again")) {
    checks.push("已有浏览器真实付款记录，本次跳过重复扣款");
    console.log(JSON.stringify({ checks, previous: JSON.parse(readFileSync(resultFile, "utf8")) }, null, 2));
  } else {
    const payerBefore = await reader.readContract({ address: config.usdc, abi: erc20Abi, functionName: "balanceOf", args: [signer.address] });
    assert.ok(payerBefore >= 1000n, "浏览器付款测试需要至少 0.001 测试 USDC");
    const page = await browser.newPage({ viewport: { width: 1360, height: 1000 }, deviceScaleFactor: 1 });
    const pageErrors = [];
    const walletMethods = [];
    page.on("pageerror", error => pageErrors.push(error.message));
    // A dedicated automated-test provider, isolated from the user's Edge profile.
    // It signs real testnet authorizations in Node; no private key enters browser code.
    await page.exposeFunction("__testWalletRequest", async ({ method, params }) => {
      walletMethods.push(method);
      if (method === "eth_requestAccounts" || method === "eth_accounts") return [signer.address];
      if (method === "eth_chainId") return "0x279f";
      if (method === "net_version") return "10143";
      if (method === "wallet_switchEthereumChain") {
        assert.equal(BigInt(params[0].chainId), 10143n);
        return null;
      }
      if (method === "eth_signTypedData_v4") {
        assert.equal(params[0].toLowerCase(), signer.address.toLowerCase());
        const typed = JSON.parse(params[1]);
        assert.equal(BigInt(typed.domain.chainId), 10143n);
        assert.equal(typed.domain.verifyingContract.toLowerCase(), config.usdc.toLowerCase());
        assert.equal(typed.primaryType, "TransferWithAuthorization");
        assert.equal(typed.message.from.toLowerCase(), signer.address.toLowerCase());
        assert.equal(typed.message.to.toLowerCase(), config.receiver.toLowerCase());
        assert.equal(BigInt(typed.message.value), 1000n);
        return signer.signTypedData({ ...typed, domain: { ...typed.domain, chainId: 10143 } });
      }
      throw new Error(`Automated test provider does not allow ${method}`);
    });
    await page.addInitScript(() => {
      window.ethereum = { request: payload => window.__testWalletRequest(payload), on() {}, removeListener() {} };
    });
    await page.goto(base, { waitUntil: "networkidle" });
    await page.getByRole("button", { name: "连接钱包", exact: true }).click();
    await page.getByRole("button", { name: "支付 0.001 测试 USDC 并解锁", exact: true }).waitFor();
    console.log("PASS: wallet connected");
    await page.getByRole("button", { name: "支付 0.001 测试 USDC 并解锁", exact: true }).click();
    try {
      await page.getByText("你的第一次 x402 付款已完成", { exact: true }).waitFor({ timeout: 60_000 });
    } catch (error) {
      await page.screenshot({ path: ".local/evidence/browser-failure.png", fullPage: true });
      console.log(JSON.stringify({ walletMethods, visibleText: await page.locator("body").innerText(), pageErrors }, null, 2));
      throw error;
    }
    const url = await page.getByRole("link", { name: "在区块浏览器核验这笔付款" }).getAttribute("href");
    const transaction = url.split("/tx/")[1];
    assert.match(transaction, /^0x[\da-fA-F]{64}$/);
    const receipt = await reader.waitForTransactionReceipt({ hash: transaction, timeout: 45_000 });
    assert.equal(receipt.status, "success");
    const transfers = parseEventLogs({ abi: erc20Abi, logs: receipt.logs, eventName: "Transfer" });
    assert.ok(transfers.find(log => log.address.toLowerCase() === config.usdc.toLowerCase() && log.args.from.toLowerCase() === signer.address.toLowerCase() && log.args.to.toLowerCase() === config.receiver.toLowerCase() && log.args.value === 1000n));
    const payerAfter = await reader.readContract({ address: config.usdc, abi: erc20Abi, functionName: "balanceOf", args: [signer.address], blockNumber: receipt.blockNumber });
    assert.equal(payerBefore - payerAfter, 1000n);
    assert.deepEqual(pageErrors, []);
    checks.push("浏览器连接、真实签名、测试网结算、内容解锁、链上回执核验均通过");
    await page.screenshot({ path: ".local/evidence/browser-paid.png", fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: ".local/evidence/browser-paid-mobile.png", fullPage: true });
    const result = { testedAt: new Date().toISOString(), network: config.network, transaction, explorer: url, payerBeforeUSDC: formatUnits(payerBefore, 6), payerAfterUSDC: formatUnits(payerAfter, 6), checks, walletMethods, pageErrors };
    writeFileSync(resultFile, JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result, null, 2));
    await page.close();
  }
} finally { await browser.close(); }
