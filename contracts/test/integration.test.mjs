import assert from "node:assert/strict";
import { before, beforeEach, describe, it } from "node:test";
import { zeroHash, encodeEventTopics, encodeAbiParameters, keccak256 } from "viem";
import { publicClient, owner, agent, attacker, recipient, unit, addressOf, request, fixture, send, id, read } from "./helpers.mjs";
import { makePaymentRequest, createPaymentExecutor, executePaymentTool, interpretReceipt, readVaultState, ABIS } from "../lib/payments.mjs";
import { scanPaymentEvents, summarizePaymentEvents } from "../lib/events.mjs";
import { parseDeploymentConfig, verifyDeployment, assertCompiledRuntime, json } from "../lib/deployment.mjs";

describe("Agent payment adapter and evidence", () => {
  let baseline, firewall, snapshot;
  before(async () => {
    ({ baseline, firewall } = await fixture());
    snapshot = await publicClient.request({ method: "evm_snapshot" });
  });
  beforeEach(async () => {
    await publicClient.request({ method: "evm_revert", params: [snapshot] });
    snapshot = await publicClient.request({ method: "evm_snapshot" });
  });
  const executor = (wallet = agent, chainId = 31337) => createPaymentExecutor({
    publicClient, walletClient: wallet, chainId,
    vaults: { baseline: baseline.address, firewall: firewall.address },
  });

  it("takes a real tool request through both modes and reads mined outcomes", async () => {
    const payload = await request("tool-e2e", { recipient: addressOf(attacker), amount: unit("3") });
    const tool = { executor: executor(), trusted: payload, arguments: JSON.stringify({ recipient: payload.recipient, amountMon: "3" }) };
    const baselineResult = await executePaymentTool({ ...tool, mode: "baseline" });
    const firewallResult = await executePaymentTool({ ...tool, mode: "firewall" });
    assert.equal(baselineResult.outcome, "paid");
    assert.equal(baselineResult.amount, unit("3"));
    assert.equal(firewallResult.outcome, "blocked");
    assert.equal(firewallResult.reason, "RECIPIENT_NOT_ALLOWED");
    assert.notEqual(baselineResult.transactionHash, firewallResult.transactionHash);
    assert.equal((await readVaultState(publicClient, firewall.address, "firewall")).balance, unit("10"));
  });

  it("queues simultaneous requests from one agent across both wallets", async () => {
    const adapter = executor();
    const payloads = await Promise.all(Array.from({ length: 8 }, (_, index) => request(`concurrent-${index}`)));
    const outcomes = await Promise.all(payloads.map((payload, index) => adapter.submit(index % 2 ? "baseline" : "firewall", payload)));
    assert.equal(outcomes.filter((item) => item.outcome === "paid").length, 8);
    assert.equal(new Set(outcomes.map((item) => item.transactionHash)).size, 8);
    assert.equal(await read(firewall, "totalPaid"), unit("0.4"));
  });

  it("continues processing after a failed request without reusing a paid ID", async () => {
    const adapter = executor(), payload = await request("adapter-replay");
    await adapter.submit("firewall", payload);
    await assert.rejects(() => adapter.submit("firewall", payload));
    assert.equal((await adapter.submit("firewall", await request("after-failure"))).outcome, "paid");
  });

  it("rejects chain mismatch, unauthorized signer and identical vault addresses", async () => {
    await assert.rejects(async () => executor(agent, 10143).submit("firewall", await request("chain")), /Chain mismatch/);
    await assert.rejects(async () => executor(owner).submit("firewall", await request("owner-tool")), /separate from owner/);
    await assert.rejects(async () => executor(attacker).submit("firewall", await request("attacker-tool")), /separate from owner/);
    assert.throws(() => createPaymentExecutor({ publicClient, walletClient: agent, chainId: 31337,
      vaults: { baseline: baseline.address, firewall: baseline.address } }), /different contracts/);
  });

  it("does not let model arguments choose mode, request ID, context or owner actions", async () => {
    const trusted = await request("host-only");
    const args = { recipient: addressOf(attacker), amountMon: "0.1" };
    for (const extra of [{ mode: "baseline" }, { requestId: id("forged") }, { ownerApproved: true }, { contextHash: zeroHash }, { deadline: "9999999999" }]) {
      await assert.rejects(() => executePaymentTool({ executor: executor(), mode: "firewall", trusted, arguments: { ...args, ...extra } }), /only recipient/);
    }
    assert.equal(await read(firewall, "requestCount"), 0n);
  });

  it("rejects float amounts, excess precision, zero, negatives and malformed IDs", async () => {
    const original = await request("input");
    const input = { ...original, amountMon: "0.1" };
    for (const amountMon of [0.1, "0", "-1", "1e6", "1.0000000000000000001", "01", "Infinity"]) {
      assert.throws(() => makePaymentRequest({ ...input, amountMon }));
    }
    for (const override of [{ requestId: zeroHash }, { contextHash: "attack" }, { deadline: -1n }, { deadline: 1.1 }, { recipient: "bad" }]) {
      assert.throws(() => makePaymentRequest({ ...input, ...override }));
    }
    assert.equal(makePaymentRequest(input).amount, unit("0.1"));
  });

  it("ignores forged payment logs from a different contract", async () => {
    const payload = await request("fake-event", { recipient: addressOf(attacker) });
    const receipt = await send(firewall, "submit", [payload]);
    const fake = {
      address: baseline.address,
      topics: encodeEventTopics({ abi: ABIS.firewall, eventName: "PaymentExecuted", args: { requestId: payload.requestId, recipient: payload.recipient } }),
      data: encodeAbiParameters([{ type: "uint256" }, { type: "bool" }], [payload.amount, false]),
    };
    const result = interpretReceipt({ receipt: { ...receipt, logs: [...receipt.logs, fake] }, address: firewall.address, mode: "firewall", requestId: payload.requestId });
    assert.equal(result.outcome, "blocked");
    assert.throws(() => interpretReceipt({ receipt: { ...receipt, logs: [fake] }, address: firewall.address, mode: "firewall", requestId: payload.requestId }), /no matching/);
  });

  it("keeps owner-approved payouts distinct from agent execution and historical denials", async () => {
    const payload = await request("statistics-owner", { recipient: addressOf(attacker) });
    await executor().submit("firewall", payload);
    const version = await read(firewall, "policyVersion");
    const receipt = await send(firewall, "approveAndExecute", [payload, version], owner);
    const result = interpretReceipt({ receipt, address: firewall.address, mode: "firewall", requestId: payload.requestId });
    assert.equal(result.ownerApproved, true);
    const state = await readVaultState(publicClient, firewall.address, "firewall");
    assert.equal(state.requestCount, 1n);
    assert.equal(state.blockedCount, 1n);
    assert.equal(state.executedCount, 1n);
    assert.equal(state.ownerApprovedCount, 1n);
    assert.equal(state.totalPaid, payload.amount);
  });

  it("reconstructs actual payment metrics from chain logs without counting replays twice", async () => {
    const hostile = await request("scan-blocked", { recipient: addressOf(attacker) });
    await executor().submit("firewall", hostile);
    await executor().submit("firewall", await request("scan-paid"));
    await send(firewall, "approveAndExecute", [hostile, await read(firewall, "policyVersion")], owner);
    const result = await scanPaymentEvents({ publicClient, address: firewall.address, mode: "firewall",
      fromBlock: firewall.deploymentReceipt.blockNumber, chunkSize: 2n });
    const metrics = summarizePaymentEvents([...result.events, ...result.events]);
    assert.deepEqual(metrics, { submitted: 2, blocked: 1, paid: 2, ownerApprovedPaid: 1,
      agentPaidAmount: unit("0.1"), ownerApprovedAmount: unit("0.1") });
    assert.equal((await publicClient.getBlock({ blockNumber: result.toBlock })).hash, result.checkpointHash);
    await assert.rejects(() => scanPaymentEvents({ publicClient, address: firewall.address, mode: "firewall", fromBlock: 0n, chunkSize: 0n }), /Invalid/);
  });

  async function manifest() {
    const vaults = {};
    for (const [mode, vault] of [["baseline", baseline], ["firewall", firewall]]) {
      vaults[mode] = { address: vault.address, runtimeCodeHash: keccak256(await publicClient.getCode({ address: vault.address })) };
    }
    return {
      chainId: 31337, status: "complete", owner: addressOf(owner), agent: addressOf(agent), vaults,
      policy: { version: await read(firewall, "policyVersion"), maxPerPayment: unit("1"), windowBudget: unit("2"), windowSeconds: 86400n, recipients: [addressOf(recipient)] },
    };
  }

  it("verifies deployment code including immutable arguments and authority", async () => {
    const data = await manifest();
    const artifacts = { UnrestrictedVault: baseline, PolicyVault: firewall };
    assert.equal((await verifyDeployment({ publicClient, manifest: JSON.parse(json(data)), artifacts })).length, 2);
    await assert.rejects(() => verifyDeployment({ publicClient, manifest: { ...data, chainId: 10143 }, artifacts }), /chain mismatch/);
    await assert.rejects(() => verifyDeployment({ publicClient, manifest: { ...data, status: "deploying" }, artifacts }), /incomplete/);
    await assert.rejects(() => verifyDeployment({ publicClient, manifest: { ...data, agent: addressOf(attacker) }, artifacts }), /Authority drift/);
    const tampered = structuredClone(data);
    tampered.vaults.firewall.runtimeCodeHash = zeroHash;
    await assert.rejects(() => verifyDeployment({ publicClient, manifest: tampered, artifacts }), /hash mismatch/);
    const wrongCode = await publicClient.getCode({ address: baseline.address });
    assert.throws(() => assertCompiledRuntime(wrongCode, firewall), /does not match/);
    await send(firewall, "setLimits", [unit("0.5"), unit("2")], owner);
    await assert.rejects(() => verifyDeployment({ publicClient, manifest: data, artifacts }), /Policy drift/);
  });

  it("validates deployment settings before any external transaction", () => {
    const env = {
      DRAGONBAIT_OWNER_ADDRESS: addressOf(owner), DRAGONBAIT_AGENT_ADDRESS: addressOf(agent),
      DRAGONBAIT_MAX_PAYMENT_MON: "0.01", DRAGONBAIT_WINDOW_BUDGET_MON: "0.05", DRAGONBAIT_WINDOW_SECONDS: "86400",
    };
    const config = parseDeploymentConfig(env);
    assert.equal(config.seedEach, 0n);
    assert.equal(config.windowBudget, unit("0.05"));
    for (const override of [
      { DRAGONBAIT_AGENT_ADDRESS: addressOf(owner) }, { DRAGONBAIT_MAX_PAYMENT_MON: "0.06" },
      { DRAGONBAIT_WINDOW_SECONDS: "0" }, { DRAGONBAIT_SEED_EACH_MON: "-1" }, { DRAGONBAIT_ALLOWED_RECIPIENTS: "bad" },
      { DRAGONBAIT_OWNER_ADDRESS: undefined },
    ]) assert.throws(() => parseDeploymentConfig({ ...env, ...override }));
  });
});
