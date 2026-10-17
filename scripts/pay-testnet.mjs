import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createPublicClient, erc20Abi, formatUnits, http, parseEventLogs } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { monadTestnet } from "viem/chains";
import { x402Client } from "@x402/core/client";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { decodePaymentResponseHeader, wrapFetchWithPayment } from "@x402/fetch";

const base = process.env.DEMO_URL || "http://127.0.0.1:3143";
const evidenceFile = process.env.PAYMENT_EVIDENCE_FILE || ".local/evidence/payment-success.json";
if (existsSync(evidenceFile) && !process.argv.includes("--again")) {
  console.log("已有成功结算凭证，本次不重复付款。若要再次测试，手动添加 --again。");
  const previous = JSON.parse(readFileSync(evidenceFile, "utf8"));
  console.log(JSON.stringify(previous, null, 2));
  process.exit(previous.chainVerification === "passed" ? 0 : 2);
}

const wallets = JSON.parse(readFileSync(".local/test-wallets.json", "utf8"));
const account = privateKeyToAccount(wallets.payer.privateKey);
const config = await fetch(`${base}/api/config`, { signal: AbortSignal.timeout(15_000) }).then(r => r.json());
assert.equal(config.chainId, 10143);
assert.equal(config.network, "eip155:10143");
assert.equal(config.amount, "1000");
assert.equal(account.address.toLowerCase(), wallets.payer.address.toLowerCase());
assert.equal(config.receiver.toLowerCase(), wallets.receiver.address.toLowerCase());

const reader = createPublicClient({ chain: monadTestnet, transport: http(config.rpc, { timeout: 15_000 }) });
const readBalance = (address, blockNumber) => reader.readContract({ address: config.usdc, abi: erc20Abi, functionName: "balanceOf", args: [address], ...(blockNumber ? { blockNumber } : {}) });
const [payerBefore, receiverBefore] = await Promise.all([readBalance(account.address), readBalance(config.receiver)]);
console.log(JSON.stringify({ network: config.network, payer: account.address, payerUSDC: formatUnits(payerBefore, 6), receiver: config.receiver, receiverUSDC: formatUnits(receiverBefore, 6) }, null, 2));
if (payerBefore < 1000n) {
  console.log("需要测试 USDC：在 https://faucet.circle.com/ 选择 USDC / Monad Testnet，填写上面的 payer 地址。");
  process.exit(2);
}

const client = new x402Client().register(config.network, new ExactEvmScheme(account));
const boundedFetch = (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(60_000) });
const paidFetch = wrapFetchWithPayment(boundedFetch, client);
const response = await paidFetch(`${base}/api/premium`, { cache: "no-store" });
if (!response.ok) {
  const diagnostic = response.headers.get("payment-required");
  throw new Error(`付款请求失败：HTTP ${response.status} ${diagnostic ? Buffer.from(diagnostic, "base64").toString("utf8") : await response.text()}`);
}
const header = response.headers.get("payment-response");
assert.ok(header, "成功响应必须带有结算凭证");
const settlement = decodePaymentResponseHeader(header);
assert.equal(settlement.success, true);
assert.equal(settlement.network, "eip155:10143");
assert.match(settlement.transaction, /^0x[\da-fA-F]{64}$/);
const content = await response.json();

// Persist the public receipt immediately: a later RPC failure must not trigger a second payment.
mkdirSync(".local/evidence", { recursive: true });
writeFileSync(evidenceFile, JSON.stringify({ paidAt: new Date().toISOString(), settlement, content, chainVerification: "pending" }, null, 2));

const receipt = await reader.waitForTransactionReceipt({ hash: settlement.transaction, timeout: 45_000 });
assert.equal(receipt.status, "success");
const transfer = parseEventLogs({ abi: erc20Abi, logs: receipt.logs, eventName: "Transfer" }).find(log =>
  log.address.toLowerCase() === config.usdc.toLowerCase() &&
  log.args.from.toLowerCase() === account.address.toLowerCase() &&
  log.args.to.toLowerCase() === config.receiver.toLowerCase() &&
  log.args.value === 1000n,
);
assert.ok(transfer, "链上回执必须包含正确的 0.001 USDC 转账事件");
const [payerAfter, receiverAfter] = await Promise.all([readBalance(account.address, receipt.blockNumber), readBalance(config.receiver, receipt.blockNumber)]);
assert.equal(payerBefore - payerAfter, 1000n);
assert.equal(receiverAfter - receiverBefore, 1000n);
assert.match(content.title, /付款已完成/);

const result = {
  verifiedAt: new Date().toISOString(),
  network: config.network,
  chainVerification: "passed",
  transaction: settlement.transaction,
  explorer: `${config.explorer}/tx/${settlement.transaction}`,
  blockNumber: receipt.blockNumber.toString(),
  payer: account.address,
  receiver: config.receiver,
  amountUSDC: "0.001",
  payerBeforeUSDC: formatUnits(payerBefore, 6),
  payerAfterUSDC: formatUnits(payerAfter, 6),
  receiverBeforeUSDC: formatUnits(receiverBefore, 6),
  receiverAfterUSDC: formatUnits(receiverAfter, 6),
  settlement,
  content,
};
writeFileSync(evidenceFile, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
