import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { formatEther } from "viem";
import { ROOT } from "./compile.mjs";
import {
  publicClient, owner, agent, recipient, attacker, addressOf, unit, fixture, request, read, send,
} from "../test/helpers.mjs";
import { createPaymentExecutor, interpretReceipt, readVaultState } from "../lib/payments.mjs";

// This is an explicitly recorded payment-intent fixture, not a claimed live AI
// jailbreak. All money movement and denials below ARE real local-EVM executions.
const { baseline, firewall } = await fixture({ max: "0.01", budget: "0.02", balance: "0.1" });
const executor = createPaymentExecutor({
  publicClient, walletClient: agent, chainId: 31337,
  vaults: { baseline: baseline.address, firewall: firewall.address },
});
const evidence = {
  formatVersion: 1, generatedAt: new Date().toISOString(), chainId: 31337,
  environment: "local-hardhat-evm", liveModelInvoked: false,
  intentSource: "deterministic demo fixture; no claim that a live model was tricked",
  chainPerformanceClaim: "Local receipt times are not Monad latency measurements.",
  vaults: { baseline: baseline.address, firewall: firewall.address },
  roles: { owner: addressOf(owner), agent: addressOf(agent), allowedRecipient: addressOf(recipient), attacker: addressOf(attacker) },
  policy: { maxPerPaymentMon: "0.01", windowBudgetMon: "0.02", windowSeconds: "86400" },
  steps: [],
};

async function perform(title, mode, payload, { approval = false } = {}) {
  const vault = mode === "baseline" ? baseline : firewall;
  const balanceBefore = await publicClient.getBalance({ address: vault.address });
  const recipientBefore = await publicClient.getBalance({ address: payload.recipient });
  const start = performance.now();
  let result;
  if (approval) {
    const version = await read(firewall, "policyVersion");
    const receipt = await send(firewall, "approveAndExecute", [payload, version], owner);
    result = interpretReceipt({ receipt, address: firewall.address, mode, requestId: payload.requestId });
  } else result = await executor.submit(mode, payload);
  const receipt = await publicClient.getTransactionReceipt({ hash: result.transactionHash });
  const balanceAfter = await publicClient.getBalance({ address: vault.address });
  const recipientAfter = await publicClient.getBalance({ address: payload.recipient });
  const expectedChange = result.outcome === "paid" ? payload.amount : 0n;
  assert.equal(balanceBefore - balanceAfter, expectedChange);
  assert.equal(recipientAfter - recipientBefore, expectedChange);
  evidence.steps.push({
    title, mode, request: payload, ...result, receiptStatus: receipt.status,
    balanceBefore, balanceAfter, recipientBefore, recipientAfter,
    localReceiptMilliseconds: Math.round(performance.now() - start), receipt,
  });
  console.log(`${title}: ${result.outcome}${result.reason ? ` (${result.reason})` : ""}`);
  console.log(`  vault ${formatEther(balanceBefore)} -> ${formatEther(balanceAfter)} MON | ${result.transactionHash}`);
  return result;
}

const hostile = await request("demo:identical-hostile-intent", { recipient: addressOf(attacker), amount: unit("0.03") });
assert.equal((await perform("1. Same intent / unrestricted pouch", "baseline", hostile)).outcome, "paid");
assert.equal((await perform("2. Same intent / policy vault", "firewall", hostile)).reason, "RECIPIENT_NOT_ALLOWED");
const oversized = await request("demo:whitelisted-but-oversized", { amount: unit("0.011") });
assert.equal((await perform("3. Whitelisted recipient, over single limit", "firewall", oversized)).reason, "SINGLE_LIMIT_EXCEEDED");
for (let index = 0; index < 2; index++) {
  const allowed = await request(`demo:legitimate-payment:${index}`, { amount: unit("0.01") });
  assert.equal((await perform(`4.${index + 1}. Legitimate allowed payment`, "firewall", allowed)).outcome, "paid");
}
const split = await request("demo:budget-drained", { amount: 1n });
assert.equal((await perform("5. One more wei after budget exhausted", "firewall", split)).reason, "WINDOW_BUDGET_EXCEEDED");
assert.equal((await perform("6. Owner explicitly approves ORIGINAL hostile request once", "firewall", hostile, { approval: true })).ownerApproved, true);
const replay = await publicClient.simulateContract({
  address: firewall.address, abi: firewall.abi, functionName: "approveAndExecute",
  args: [hostile, await read(firewall, "policyVersion")], account: owner.account,
}).then(() => false, (error) => error.walk?.((cause) => cause.name === "ContractFunctionRevertedError")?.data?.errorName === "NotBlockedRequest");
assert.equal(replay, true);
evidence.replayedOwnerApprovalRejected = replay;
evidence.finalStates = await Promise.all([
  readVaultState(publicClient, baseline.address, "baseline"),
  readVaultState(publicClient, firewall.address, "firewall"),
]);
assert.equal(evidence.finalStates[1].ownerApprovedCount, 1n);
assert.equal(evidence.finalStates[1].totalPaid, unit("0.05"));
const outputDirectory = path.join(ROOT, ".local", "demo");
await fs.mkdir(outputDirectory, { recursive: true });
const outputFile = path.join(outputDirectory, "evidence.json");
await fs.writeFile(outputFile, `${JSON.stringify(evidence, (_, value) => typeof value === "bigint" ? value.toString() : value, 2)}\n`);
console.log(`Verified ${evidence.steps.length} mined outcomes. Evidence: ${outputFile}`);
console.log("The local node stops after this command; evidence remains readable. No Monad testnet deployment or live AI call was made.");
