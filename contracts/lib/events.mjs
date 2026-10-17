import { getAddress } from "viem";
import { ABIS, BLOCK_REASONS } from "./payments.mjs";

const PAYMENT_EVENTS = new Set(["PaymentRequested", "PaymentBlocked", "PaymentExecuted", "OwnerApprovalUsed"]);

/** Historical readback is the source of truth; WebSocket/SSE can be an optional
 *  UI accelerator later. Scan from deploymentBlock to correlate original
 *  requests with approvals. Callers should persist a block hash checkpoint and
 *  rescan overlapping blocks after a reconnect/reorg.
 */
export async function scanPaymentEvents({ publicClient, address, mode, fromBlock, toBlock, chunkSize = 500n }) {
  if (!ABIS[mode]) throw new Error("Unknown vault mode");
  address = getAddress(address);
  if (typeof fromBlock !== "bigint" || fromBlock < 0n || typeof chunkSize !== "bigint" || chunkSize < 1n) throw new Error("Invalid event scan range");
  const end = toBlock ?? await publicClient.getBlockNumber({ cacheTime: 0 });
  if (typeof end !== "bigint" || end < fromBlock) throw new Error("Invalid event scan end");
  const checkpoint = await publicClient.getBlock({ blockNumber: end });
  const events = [], seen = new Set();
  for (let start = fromBlock; start <= end; start += chunkSize) {
    const last = start + chunkSize - 1n > end ? end : start + chunkSize - 1n;
    const logs = await publicClient.getContractEvents({ address, abi: ABIS[mode], fromBlock: start, toBlock: last, strict: true });
    for (const log of logs) {
      if (!PAYMENT_EVENTS.has(log.eventName) || log.removed) continue;
      const key = `${log.blockHash}:${log.transactionHash}:${log.logIndex}`;
      if (seen.has(key)) continue;
      seen.add(key);
      events.push({ ...log, mode, reason: log.eventName === "PaymentBlocked" ? BLOCK_REASONS[log.args.reason] : undefined });
    }
  }
  events.sort((left, right) => left.blockNumber < right.blockNumber ? -1 : left.blockNumber > right.blockNumber ? 1 : left.logIndex - right.logIndex);
  // Detect a reorg affecting this scan's anchor rather than silently mixing
  // logs from different histories. This is not a finality guarantee.
  const after = await publicClient.getBlock({ blockNumber: end });
  if (after.hash !== checkpoint.hash) throw new Error("Chain changed during event scan; rescan from checkpoint");
  return { address, mode, fromBlock, toBlock: end, checkpointHash: after.hash, events };
}

/** Raw metrics only. Game points, wins, identity and ranking remain undecided. */
export function summarizePaymentEvents(events) {
  const totals = { submitted: 0, blocked: 0, paid: 0, ownerApprovedPaid: 0, agentPaidAmount: 0n, ownerApprovedAmount: 0n };
  const seen = new Set();
  for (const event of events) {
    const key = `${event.address.toLowerCase()}:${event.transactionHash}:${event.logIndex}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (event.eventName === "PaymentRequested") totals.submitted++;
    if (event.eventName === "PaymentBlocked") totals.blocked++;
    if (event.eventName === "PaymentExecuted") {
      totals.paid++;
      if (event.args.ownerApproved) {
        totals.ownerApprovedPaid++;
        totals.ownerApprovedAmount += event.args.amount;
      } else totals.agentPaidAmount += event.args.amount;
    }
  }
  return totals;
}
