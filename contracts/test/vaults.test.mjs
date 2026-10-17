import assert from "node:assert/strict";
import { before, beforeEach, describe, it } from "node:test";
import { decodeEventLog, encodeFunctionData, zeroAddress, zeroHash } from "viem";
import {
  publicClient, owner, agent, recipient, attacker, nextOwner, nextAgent,
  unit, id, addressOf, deploy, read, send, request, fixture, fund,
} from "./helpers.mjs";

async function expectRevert(vault, functionName, args, errorName, wallet = agent) {
  await assert.rejects(() => publicClient.simulateContract({
    address: vault.address, abi: vault.abi, functionName, args, account: wallet.account,
  }), (error) => {
    const cause = error.walk?.((item) => item.name === "ContractFunctionRevertedError");
    assert.equal(cause?.data?.errorName, errorName, error.shortMessage);
    return true;
  });
}
function events(vault, receipt) {
  return receipt.logs.filter((log) => log.address.toLowerCase() === vault.address.toLowerCase())
    .map((log) => decodeEventLog({ abi: vault.abi, data: log.data, topics: log.topics }));
}
async function expectBlocked(vault, payload, reason) {
  const before = await publicClient.getBalance({ address: vault.address });
  const receipt = await send(vault, "submit", [payload]);
  assert.equal(receipt.status, "success");
  const blocked = events(vault, receipt).find((event) => event.eventName === "PaymentBlocked");
  assert.equal(blocked?.args.reason, reason);
  assert.equal(await publicClient.getBalance({ address: vault.address }), before);
  const record = await read(vault, "requests", [payload.requestId]);
  assert.equal(record[2], 1); // Blocked
  assert.equal(record[3], reason);
  assert.equal(record[0], await read(vault, "hashRequest", [payload]));
  return receipt;
}

describe("Native-MON custody and policy enforcement", () => {
  let baseline, firewall, snapshot;
  before(async () => {
    ({ baseline, firewall } = await fixture());
    snapshot = await publicClient.request({ method: "evm_snapshot" });
  });
  beforeEach(async () => {
    assert.equal(await publicClient.request({ method: "evm_revert", params: [snapshot] }), true);
    snapshot = await publicClient.request({ method: "evm_snapshot" });
  });

  it("keeps deposits in two distinct contracts with different authorization", async () => {
    assert.notEqual(baseline.address, firewall.address);
    for (const vault of [baseline, firewall]) {
      assert.equal(await read(vault, "owner"), addressOf(owner));
      assert.equal(await read(vault, "agent"), addressOf(agent));
      assert.equal(await publicClient.getBalance({ address: vault.address }), unit("10"));
      assert.notEqual(await publicClient.getCode({ address: vault.address }), "0x");
    }
  });

  it("rejects deployment with invalid roles, empty caps or a zero-length budget window", async () => {
    for (const args of [
      [zeroAddress, addressOf(agent), 1n, 2n, 86400n],
      [addressOf(owner), zeroAddress, 1n, 2n, 86400n],
      [addressOf(owner), addressOf(owner), 1n, 2n, 86400n],
      [addressOf(owner), addressOf(agent), 0n, 2n, 86400n],
      [addressOf(owner), addressOf(agent), 2n, 1n, 86400n],
      [addressOf(owner), addressOf(agent), 1n, 2n, 0n],
    ]) await assert.rejects(() => deploy("PolicyVault", args));
  });

  it("executes the same hostile intent on baseline and blocks it on firewall", async () => {
    const payload = await request("same-attack", { recipient: addressOf(attacker), amount: unit("3") });
    const initial = await publicClient.getBalance({ address: addressOf(attacker) });
    const paid = await send(baseline, "submit", [payload]);
    assert.equal(paid.status, "success");
    assert.equal(events(baseline, paid).at(-1).eventName, "PaymentExecuted");
    assert.equal(await publicClient.getBalance({ address: addressOf(attacker) }), initial + payload.amount);
    await expectBlocked(firewall, payload, 1);
    assert.equal(await read(baseline, "totalPaid"), payload.amount);
    assert.equal(await read(firewall, "totalPaid"), 0n);
  });

  it("allows an authorized, whitelisted request at the exact single limit", async () => {
    const payload = await request("legal", { amount: unit("1") });
    const initial = await publicClient.getBalance({ address: payload.recipient });
    assert.equal(await read(firewall, "preview", [payload]), 0);
    const receipt = await send(firewall, "submit", [payload]);
    assert.equal(receipt.status, "success");
    assert.equal(await publicClient.getBalance({ address: payload.recipient }), initial + payload.amount);
    assert.equal(await read(firewall, "remainingBudget"), unit("1"));
  });

  it("blocks a non-whitelisted recipient even for one wei", async () => {
    await expectBlocked(firewall, await request("not-allowed", { recipient: addressOf(attacker), amount: 1n }), 1);
  });

  it("enforces the single payment cap on a whitelisted recipient", async () => {
    await expectBlocked(firewall, await request("too-big", { amount: unit("1") + 1n }), 2);
  });

  it("prevents splitting an attack into many allowed-size payments", async () => {
    for (let index = 0; index < 4; index++) {
      assert.equal((await send(firewall, "submit", [await request(`split-${index}`, { amount: unit("0.5") })])).status, "success");
    }
    await expectBlocked(firewall, await request("split-overflow", { amount: 1n }), 3);
    assert.equal(await read(firewall, "totalPaid"), unit("2"));
    assert.equal(await read(firewall, "remainingBudget"), 0n);
  });

  it("shares the window budget between all allowed recipients", async () => {
    await send(firewall, "setRecipient", [addressOf(attacker), true], owner);
    await send(firewall, "submit", [await request("shared-1", { amount: unit("1") })]);
    await send(firewall, "submit", [await request("shared-2", { amount: unit("1"), recipient: addressOf(attacker) })]);
    await expectBlocked(firewall, await request("shared-3", { amount: 1n }), 3);
  });

  it("only the owner can change recipients, caps, agent or pause state", async () => {
    for (const [name, args] of [
      ["setRecipient", [addressOf(attacker), true]], ["setLimits", [unit("5"), unit("10")]],
      ["setAgent", [addressOf(attacker)]], ["pause", []], ["transferOwnership", [addressOf(attacker)]],
    ]) await expectRevert(firewall, name, args, "OwnableUnauthorizedAccount");
  });

  it("rejects external users and the owner at the agent submit entry point", async () => {
    for (const vault of [baseline, firewall]) {
      for (const wallet of [attacker, owner]) {
        await expectRevert(vault, "submit", [await request("unauthorized")], "UnauthorizedAgent", wallet);
      }
    }
  });

  it("supports pausing both vaults without preventing deposits", async () => {
    for (const vault of [baseline, firewall]) {
      await send(vault, "pause", [], owner);
      await expectRevert(vault, "submit", [await request("paused")], "EnforcedPause");
      await fund(vault, 1n);
      await send(vault, "unpause", [], owner);
      assert.equal((await send(vault, "submit", [await request(`resumed-${vault.address}`)])).status, "success");
    }
  });

  it("rejects replay and mutated payloads after a paid request", async () => {
    const payload = await request("replay-paid");
    await send(firewall, "submit", [payload]);
    for (const altered of [payload, { ...payload, amount: 1n }, { ...payload, recipient: addressOf(attacker) }]) {
      await expectRevert(firewall, "submit", [altered], "RequestAlreadyProcessed");
    }
    assert.equal(await read(firewall, "requestCount"), 1n);
  });

  it("also consumes a blocked request ID, preventing retry spam", async () => {
    const payload = await request("replay-blocked", { recipient: addressOf(attacker) });
    await expectBlocked(firewall, payload, 1);
    await expectRevert(firewall, "submit", [payload], "RequestAlreadyProcessed");
    await expectRevert(firewall, "submit", [{ ...payload, recipient: addressOf(recipient) }], "RequestAlreadyProcessed");
    assert.equal(await read(firewall, "blockedCount"), 1n);
  });

  it("rejects zero ID, zero amount, invalid recipients and expired payloads", async () => {
    for (const [override, error] of [
      [{ requestId: zeroHash }, "InvalidRequestId"], [{ amount: 0n }, "InvalidAmount"],
      [{ recipient: zeroAddress }, "InvalidRecipient"], [{ recipient: firewall.address }, "InvalidRecipient"],
      [{ deadline: 1n }, "RequestExpired"],
    ]) await expectRevert(firewall, "submit", [await request("malformed", override)], error);
    assert.equal(await read(firewall, "requestCount"), 0n);
  });

  it("domain-separates hashes by custody contract and commits every payload field", async () => {
    const payload = await request("domain");
    const hash = await read(firewall, "hashRequest", [payload]);
    assert.notEqual(hash, await read(baseline, "hashRequest", [payload]));
    for (const override of [{ requestId: id("other") }, { recipient: addressOf(attacker) }, { amount: 1n },
      { contextHash: id("other-context") }, { deadline: payload.deadline + 1n }]) {
      assert.notEqual(hash, await read(firewall, "hashRequest", [{ ...payload, ...override }]));
    }
    const originalChainId = await publicClient.getChainId();
    assert.equal(originalChainId, 31337);
  });

  it("records an insufficient-balance denial without moving money", async () => {
    const empty = await fixture({ balance: "0" });
    const payload = await request("no-funds");
    await expectBlocked(empty.baseline, payload, 4);
    await expectBlocked(empty.firewall, payload, 4);
  });

  it("only allows the owner to approve an exact blocked request once", async () => {
    const payload = await request("owner-once", { recipient: addressOf(attacker), amount: unit("3") });
    await expectBlocked(firewall, payload, 1);
    const version = await read(firewall, "policyVersion");
    await expectRevert(firewall, "approveAndExecute", [payload, version], "OwnableUnauthorizedAccount");
    const receipt = await send(firewall, "approveAndExecute", [payload, version], owner);
    assert.equal(receipt.status, "success");
    assert.equal(events(firewall, receipt).find((event) => event.eventName === "PaymentExecuted").args.ownerApproved, true);
    assert.equal(await read(firewall, "ownerApprovedCount"), 1n);
    assert.equal(await read(firewall, "remainingBudget"), 0n);
    await expectRevert(firewall, "approveAndExecute", [payload, version], "NotBlockedRequest", owner);
    await expectRevert(firewall, "submit", [payload], "RequestAlreadyProcessed");
    await expectBlocked(firewall, await request("after-approval", { amount: 1n }), 3);
  });

  it("binds owner approval to recipient, amount, context and expiry", async () => {
    const payload = await request("approval-binding", { recipient: addressOf(attacker) });
    await expectBlocked(firewall, payload, 1);
    const version = await read(firewall, "policyVersion");
    for (const override of [{ recipient: addressOf(recipient) }, { amount: 1n },
      { contextHash: id("forged") }, { deadline: payload.deadline + 1n }]) {
      await expectRevert(firewall, "approveAndExecute", [{ ...payload, ...override }, version], "IntentMismatch", owner);
    }
    await expectRevert(firewall, "approveAndExecute", [{ ...payload, requestId: id("unknown") }, version], "NotBlockedRequest", owner);
    await expectRevert(firewall, "approveAndExecute", [payload, version + 1n], "StalePolicy", owner);
  });

  it("invalidates pending requests after a policy or authority change", async () => {
    for (const [index, name, args, wallet] of [
      [0, "setLimits", [unit("0.5"), unit("2")], owner],
      [1, "setRecipient", [addressOf(attacker), true], owner],
      [2, "setAgent", [addressOf(nextAgent)], owner],
    ]) {
      if (index === 2) await send(firewall, "setRecipient", [addressOf(attacker), false], owner);
      const payload = await request(`stale-${index}`, { recipient: addressOf(attacker), amount: unit("1") });
      assert.equal((await send(firewall, "submit", [payload])).status, "success");
      const beforeVersion = await read(firewall, "policyVersion");
      await send(firewall, name, args, wallet);
      assert.equal(await read(firewall, "policyVersion"), beforeVersion + 1n);
      await expectRevert(firewall, "approveAndExecute", [payload, beforeVersion + 1n], "StalePolicy", owner);
    }
  });

  it("owner approval still obeys expiry and the emergency pause", async () => {
    const block = await publicClient.getBlock();
    const payload = await request("approval-expired", { recipient: addressOf(attacker), deadline: block.timestamp + 30n });
    await send(firewall, "submit", [payload]);
    const version = await read(firewall, "policyVersion");
    await send(firewall, "pause", [], owner);
    await expectRevert(firewall, "approveAndExecute", [payload, version], "EnforcedPause", owner);
    await send(firewall, "unpause", [], owner);
    await publicClient.request({ method: "evm_setNextBlockTimestamp", params: [Number(payload.deadline + 1n)] });
    await publicClient.request({ method: "evm_mine" });
    await expectRevert(firewall, "approveAndExecute", [payload, version], "RequestExpired", owner);
  });

  it("does not count a failed recipient call as a payment or consume budget", async () => {
    const rejecting = await deploy("RejectingReceiver", []);
    await send(firewall, "setRecipient", [rejecting.address, true], owner);
    const payload = await request("receiver-reverts", { recipient: rejecting.address });
    await expectRevert(firewall, "submit", [payload], "NativeTransferFailed");
    // Send with explicit gas to produce a real reverted receipt as well.
    const receipt = await send(firewall, "submit", [payload], agent, { gas: 500_000n });
    assert.equal(receipt.status, "reverted");
    assert.equal(receipt.logs.length, 0);
    assert.equal(await read(firewall, "requestCount"), 0n);
    assert.equal(await read(firewall, "remainingBudget"), unit("2"));
    assert.equal((await read(firewall, "requests", [payload.requestId]))[2], 0);
  });

  it("rolls back a failed owner-approved transfer while retaining the original denial", async () => {
    const rejecting = await deploy("RejectingReceiver", []);
    const payload = await request("approval-reverts", { recipient: rejecting.address });
    await expectBlocked(firewall, payload, 1);
    const version = await read(firewall, "policyVersion");
    const receipt = await send(firewall, "approveAndExecute", [payload, version], owner, { gas: 500_000n });
    assert.equal(receipt.status, "reverted");
    assert.equal(await read(firewall, "ownerApprovedCount"), 0n);
    assert.equal(await read(firewall, "blockedCount"), 1n);
    assert.equal((await read(firewall, "requests", [payload.requestId]))[2], 1);
  });

  it("does not let policy edits reset previously spent budget", async () => {
    await send(firewall, "submit", [await request("before-edit", { amount: unit("1") })]);
    await send(firewall, "setLimits", [unit("0.5"), unit("0.5")], owner);
    assert.equal(await read(firewall, "remainingBudget"), 0n);
    await expectBlocked(firewall, await request("after-edit", { amount: 1n }), 3);
    await send(firewall, "setLimits", [unit("1"), unit("2")], owner);
    assert.equal(await read(firewall, "remainingBudget"), unit("1"));
  });

  it("opens a new fixed window and preserves previous window accounting", async () => {
    const window = await read(firewall, "currentWindow");
    await send(firewall, "submit", [await request("window-one", { amount: unit("1") })]);
    await publicClient.request({ method: "evm_setNextBlockTimestamp", params: [Number((window + 1n) * 86400n)] });
    await publicClient.request({ method: "evm_mine" });
    assert.equal(await read(firewall, "currentWindow"), window + 1n);
    assert.equal(await read(firewall, "remainingBudget"), unit("2"));
    assert.equal(await read(firewall, "spentInWindow", [window]), unit("1"));
    await send(firewall, "submit", [await request("window-two", { amount: unit("1") })]);
    assert.equal(await read(firewall, "totalPaid"), unit("2"));
  });

  it("requires a two-step ownership transfer and keeps owner and agent separate", async () => {
    await expectRevert(firewall, "setAgent", [addressOf(owner)], "OwnerCannotBeAgent", owner);
    await expectRevert(firewall, "setAgent", [zeroAddress], "InvalidAgent", owner);
    await expectRevert(firewall, "transferOwnership", [addressOf(agent)], "OwnerCannotBeAgent", owner);
    await send(firewall, "transferOwnership", [addressOf(nextOwner)], owner);
    assert.equal(await read(firewall, "owner"), addressOf(owner));
    await expectRevert(firewall, "setAgent", [addressOf(nextOwner)], "OwnerCannotBeAgent", owner);
    await expectRevert(firewall, "acceptOwnership", [], "OwnableUnauthorizedAccount", attacker);
    const version = await read(firewall, "policyVersion");
    await send(firewall, "acceptOwnership", [], nextOwner);
    assert.equal(await read(firewall, "owner"), addressOf(nextOwner));
    assert.equal(await read(firewall, "policyVersion"), version + 1n);
    await expectRevert(firewall, "pause", [], "OwnableUnauthorizedAccount", owner);
    await expectRevert(firewall, "renounceOwnership", [], "OwnershipRenunciationDisabled", nextOwner);
  });

  it("rotates agent authority without affecting custody or spent budget", async () => {
    await send(firewall, "submit", [await request("old-agent")]);
    await send(firewall, "setAgent", [addressOf(nextAgent)], owner);
    await expectRevert(firewall, "submit", [await request("revoked-agent")], "UnauthorizedAgent");
    await send(firewall, "submit", [await request("new-agent")], nextAgent);
    assert.equal(await read(firewall, "remainingBudget"), unit("1.8"));
  });

  it("rejects invalid cap updates rather than weakening authorization", async () => {
    for (const caps of [[0n, 1n], [1n, 0n], [2n, 1n]]) {
      await expectRevert(firewall, "setLimits", caps, "InvalidLimits", owner);
    }
    for (const address of [zeroAddress, firewall.address]) {
      await expectRevert(firewall, "setRecipient", [address, true], "InvalidRecipient", owner);
    }
  });

  it("blocks reentrant payments even when the recipient IS the authorized agent", async () => {
    const reentrant = await deploy("ReentrantAgent", []);
    await send(firewall, "setAgent", [reentrant.address], owner);
    await send(firewall, "setRecipient", [reentrant.address, true], owner);
    const outer = await request("reentrant-outer", { recipient: reentrant.address, amount: unit("1") });
    const nested = await request("reentrant-nested", { amount: unit("1") });
    const data = encodeFunctionData({ abi: firewall.abi, functionName: "submit", args: [nested] });
    const receipt = await send(reentrant, "attack", [firewall.address, outer, data], attacker);
    assert.equal(receipt.status, "success");
    assert.equal(await read(reentrant, "reentrySucceeded"), false);
    assert.equal(await read(firewall, "executedCount"), 1n);
    assert.equal((await read(firewall, "requests", [nested.requestId]))[2], 0);
  });

  it("conserves funds and budget across a deterministic mixed attack sequence", async () => {
    let seed = 42, expectedPaid = 0n, expectedBlocked = 0n;
    const openingBalance = await publicClient.getBalance({ address: firewall.address });
    const budget = unit("2"), cap = unit("1");
    for (let index = 0; index < 48; index++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      const amount = BigInt(seed % 17 + 1) * unit("0.1");
      const allowed = seed % 3 !== 0;
      const payload = await request(`mixed-${index}`, { amount, recipient: addressOf(allowed ? recipient : attacker) });
      const reason = !allowed ? 1 : amount > cap ? 2 : expectedPaid + amount > budget ? 3 : 0;
      const receipt = await send(firewall, "submit", [payload]);
      assert.equal(receipt.status, "success");
      if (reason) {
        expectedBlocked++;
        assert.equal(events(firewall, receipt).at(-1).args.reason, reason);
      } else expectedPaid += amount;
      assert.equal(await publicClient.getBalance({ address: firewall.address }), openingBalance - expectedPaid);
      assert.equal(await read(firewall, "totalPaid"), expectedPaid);
      assert.equal(await read(firewall, "remainingBudget"), budget - expectedPaid);
    }
    assert.equal(await read(firewall, "requestCount"), 48n);
    assert.equal(await read(firewall, "blockedCount"), expectedBlocked);
  });
});
