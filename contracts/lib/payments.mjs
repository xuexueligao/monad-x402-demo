import { getAddress, parseEther, decodeEventLog, zeroAddress, zeroHash } from "viem";
import baselineAbi from "../abi/UnrestrictedVault.json" with { type: "json" };
import firewallAbi from "../abi/PolicyVault.json" with { type: "json" };

export const ABIS = Object.freeze({ baseline: baselineAbi, firewall: firewallAbi });
export const BLOCK_REASONS = Object.freeze([
  "NONE", "RECIPIENT_NOT_ALLOWED", "SINGLE_LIMIT_EXCEEDED", "WINDOW_BUDGET_EXCEEDED", "INSUFFICIENT_BALANCE",
]);
const bytes32 = (value) => typeof value === "string" && /^0x[0-9a-fA-F]{64}$/.test(value);

export function makePaymentRequest({ requestId, recipient, amountMon, contextHash, deadline }) {
  if (!bytes32(requestId) || requestId === zeroHash) throw new Error("Invalid server-generated requestId");
  if (!bytes32(contextHash)) throw new Error("contextHash must be bytes32");
  const address = getAddress(recipient);
  if (address === zeroAddress) throw new Error("Invalid recipient");
  if (typeof amountMon !== "string" || !/^(0|[1-9]\d*)(\.\d{1,18})?$/.test(amountMon)) {
    throw new Error("amountMon must be a decimal string with at most 18 decimal places");
  }
  const amount = parseEther(amountMon);
  if (amount <= 0n || amount >= 2n ** 256n) throw new Error("Amount is outside uint256 range");
  if ((typeof deadline !== "bigint" && typeof deadline !== "string") || !/^\d+$/.test(String(deadline))) {
    throw new Error("deadline must be an integer string or bigint");
  }
  const expires = BigInt(deadline);
  if (expires <= 0n || expires >= 2n ** 64n) throw new Error("Deadline is outside uint64 range");
  return { requestId, recipient: address, amount, contextHash, deadline: expires };
}

/** Interpret only this vault's logs; receipt.status=success does NOT mean paid. */
export function interpretReceipt({ receipt, address, mode, requestId }) {
  if (!ABIS[mode]) throw new Error("Unknown vault mode");
  if (receipt.status === "reverted") return { outcome: "reverted", transactionHash: receipt.transactionHash, requestId, events: [] };
  const events = receipt.logs.filter((log) => log.address.toLowerCase() === address.toLowerCase()).flatMap((log) => {
    try { return [decodeEventLog({ abi: ABIS[mode], data: log.data, topics: log.topics, strict: true })]; }
    catch { return []; }
  });
  const paid = events.find((event) => event.eventName === "PaymentExecuted" && event.args.requestId === requestId);
  const blocked = events.find((event) => event.eventName === "PaymentBlocked" && event.args.requestId === requestId);
  if (paid && blocked) throw new Error("Conflicting payment events");
  if (!paid && !blocked) throw new Error("Successful receipt contains no matching payment outcome");
  return {
    outcome: paid ? "paid" : "blocked", requestId, transactionHash: receipt.transactionHash,
    blockNumber: receipt.blockNumber, gasUsed: receipt.gasUsed,
    reason: blocked ? BLOCK_REASONS[blocked.args.reason] : undefined,
    recipient: paid?.args.recipient, amount: paid?.args.amount, ownerApproved: paid?.args.ownerApproved ?? false,
    events,
  };
}

/** One executor per signing wallet. Its queue serializes all modes to avoid
 *  concurrent nonce collisions at a live event. Multiple server processes must
 *  share a durable nonce/transaction queue; this in-memory queue is one process.
 *  The owner key is never accepted here and there is no owner-approval method.
 */
export function createPaymentExecutor({ publicClient, walletClient, chainId, vaults, confirmations = 1 }) {
  if (!walletClient.account) throw new Error("An agent signing account is required");
  const addresses = Object.fromEntries(Object.entries(vaults).map(([mode, address]) => {
    if (!ABIS[mode]) throw new Error(`Unknown mode: ${mode}`);
    const normalized = getAddress(address);
    if (normalized === zeroAddress) throw new Error("Vault cannot be zero address");
    return [mode, normalized];
  }));
  if (new Set(Object.values(addresses).map((address) => address.toLowerCase())).size !== Object.keys(addresses).length) {
    throw new Error("Baseline and firewall must use different contracts");
  }
  let pending = Promise.resolve();
  async function submit(mode, request) {
    if (!addresses[mode]) throw new Error("Vault mode is not configured");
    if (await publicClient.getChainId() !== chainId || await walletClient.getChainId() !== chainId) {
      throw new Error("Chain mismatch");
    }
    const address = addresses[mode], abi = ABIS[mode];
    const [authorizedAgent, owner] = await Promise.all([
      publicClient.readContract({ address, abi, functionName: "agent" }),
      publicClient.readContract({ address, abi, functionName: "owner" }),
    ]);
    const signer = getAddress(walletClient.account.address);
    if (signer !== getAddress(authorizedAgent) || signer === getAddress(owner)) {
      throw new Error("Executor signer must be the contract's agent, separate from owner");
    }
    // Estimate/simulate for parameter, replay and pause errors. Policy denials
    // return false, so they still proceed to a mined, observable transaction.
    const { request: transaction } = await publicClient.simulateContract({
      address, abi, functionName: "submit", args: [request], account: walletClient.account,
    });
    const transactionHash = await walletClient.writeContract(transaction);
    const receipt = await publicClient.waitForTransactionReceipt({ hash: transactionHash, confirmations });
    return interpretReceipt({ receipt, address, mode, requestId: request.requestId });
  }
  return {
    submit(mode, request) {
      const execution = pending.then(() => submit(mode, request));
      pending = execution.catch(() => {});
      return execution;
    },
  };
}

// This is a model-tool schema only. Host code chooses the vault, request ID,
// context hash and expiry; prompt text cannot switch to a weaker vault or owner.
export const PAYMENT_TOOL = Object.freeze({
  type: "function",
  name: "request_payment",
  description: "Propose a native MON payment. The wallet's independent authorization rules decide whether it executes.",
  strict: true,
  parameters: {
    type: "object", additionalProperties: false,
    properties: { recipient: { type: "string" }, amountMon: { type: "string" } },
    required: ["recipient", "amountMon"],
  },
});

export async function executePaymentTool({ executor, mode, arguments: argumentsValue, trusted }) {
  const args = typeof argumentsValue === "string" ? JSON.parse(argumentsValue) : argumentsValue;
  if (!args || typeof args !== "object" || Array.isArray(args) ||
    Object.keys(args).length !== 2 || !Object.hasOwn(args, "recipient") || !Object.hasOwn(args, "amountMon")) {
    throw new Error("Tool accepts only recipient and amountMon");
  }
  const request = makePaymentRequest({ ...trusted, recipient: args.recipient, amountMon: args.amountMon });
  return executor.submit(mode, request);
}

export async function readVaultState(publicClient, address, mode) {
  const abi = ABIS[mode];
  if (!abi) throw new Error("Unknown vault mode");
  const fields = ["requestCount", "blockedCount", "executedCount", "ownerApprovedCount", "totalPaid", "owner", "agent", "paused"];
  if (mode === "firewall") fields.push("policyVersion", "maxPerPayment", "windowBudget", "windowSeconds", "remainingBudget", "currentWindow");
  const blockNumber = await publicClient.getBlockNumber({ cacheTime: 0 });
  const values = await Promise.all(fields.map((functionName) => publicClient.readContract({ address, abi, functionName, blockNumber })));
  const balance = await publicClient.getBalance({ address, blockNumber });
  return { address, mode, blockNumber, balance, ...Object.fromEntries(fields.map((name, index) => [name, values[index]])) };
}
