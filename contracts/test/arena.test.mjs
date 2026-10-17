import assert from "node:assert/strict";
import { before, beforeEach, describe, it } from "node:test";
import { decodeEventLog, hashTypedData, zeroAddress, zeroHash } from "viem";
import { publicClient, owner, agent, recipient, attacker, unit, id, addressOf, deploy, read, send, fund } from "./helpers.mjs";

const types = { ChallengeResult: [
  { name: "challengeId", type: "bytes32" }, { name: "player", type: "address" },
  { name: "roundId", type: "uint256" }, { name: "success", type: "bool" },
  { name: "score", type: "uint256" }, { name: "deadline", type: "uint256" },
  { name: "transcriptHash", type: "bytes32" },
] };
const fee = unit("10");
const constructorArgs = [addressOf(owner), fee, 8000n, 5000n, 7200n];
function domain(arena, overrides = {}) {
  return { name: "Monad Rug Arena", version: "1", chainId: 31337, verifyingContract: arena.address, ...overrides };
}
async function result(arena, label, overrides = {}) {
  const block = await publicClient.getBlock();
  const success = overrides.success ?? false;
  return { challengeId: id(label), player: addressOf(agent), roundId: await read(arena, "currentRoundId"),
    success, score: success ? 100n : 10n, deadline: block.timestamp + 300n, transcriptHash: id(`transcript:${label}`), ...overrides };
}
async function sign(arena, value, wallet = owner, domainOverrides = {}) {
  return wallet.signTypedData({ domain: domain(arena, domainOverrides), types, primaryType: "ChallengeResult", message: value });
}
async function settle(arena, value, wallet = agent) {
  return send(arena, "settleChallenge", [value, await sign(arena, value)], wallet, { value: fee });
}
async function reverts(arena, functionName, args, errorName, wallet = agent, value = 0n) {
  await assert.rejects(() => publicClient.simulateContract({ address: arena.address, abi: arena.abi,
    functionName, args, account: wallet.account, value }), (error) => {
    const cause = error.walk?.((entry) => entry.name === "ContractFunctionRevertedError");
    assert.equal(cause?.data?.errorName, errorName, error.shortMessage);
    return true;
  });
}
function events(arena, receipt) {
  return receipt.logs.filter((log) => log.address.toLowerCase() === arena.address.toLowerCase())
    .map((log) => decodeEventLog({ abi: arena.abi, data: log.data, topics: log.topics }));
}

describe("RugArena: signed dialogue, shared rounds and native MON", () => {
  let arena, snapshot;
  before(async () => {
    arena = await deploy("RugArena", constructorArgs);
    snapshot = await publicClient.request({ method: "evm_snapshot" });
  });
  beforeEach(async () => {
    assert.equal(await publicClient.request({ method: "evm_revert", params: [snapshot] }), true);
    snapshot = await publicClient.request({ method: "evm_snapshot" });
  });

  it("starts round one with public, named settings and no fabricated prize pool", async () => {
    const round = await read(arena, "getCurrentRound");
    assert.equal(round.id, 1n);
    assert.equal(round.challengeFee, fee);
    assert.equal(round.prizePool, 0n);
    assert.equal(round.active, true);
    assert.equal(round.winner, zeroAddress);
    assert.equal(await read(arena, "resultSigner"), addressOf(owner));
    assert.equal(events(arena, arena.deploymentReceipt)[0].eventName, "GameRoundStarted");
    await reverts(arena, "startGameRound", [], "RoundStillActive");
  });

  it("settles a real signed failure, records fee and transcript hash, and credits the pool", async () => {
    const value = await result(arena, "normal");
    const receipt = await settle(arena, value);
    assert.equal(receipt.status, "success");
    const challenge = await read(arena, "getChallenge", [value.challengeId]);
    assert.equal(challenge.settled, true);
    assert.equal(challenge.player, addressOf(agent));
    assert.equal(challenge.fee, fee);
    assert.equal(challenge.transcriptHash, value.transcriptHash);
    assert.deepEqual(await read(arena, "getPlayerStats", [addressOf(agent)]), { attempts: 1n, successes: 0n, score: 10n, wins: 0n });
    assert.equal(await read(arena, "totalChallenges"), 1n);
    assert.equal(await read(arena, "prizePool"), unit("8"));
    assert.equal(await publicClient.getBalance({ address: arena.address }), fee);
    assert.deepEqual(events(arena, receipt).map((event) => event.eventName), ["ChallengeSettled", "PrizePoolUpdated"]);
  });

  it("rejects an unsigned result, an unrelated signer and mutated model verdict", async () => {
    const value = await result(arena, "forged");
    const validSignature = await sign(arena, value);
    for (const signature of ["0x", await sign(arena, value, attacker)]) {
      await reverts(arena, "settleChallenge", [value, signature], "InvalidSignature", agent, fee);
    }
    await reverts(arena, "settleChallenge", [{ ...value, success: true, score: 100n }, validSignature], "InvalidSignature", agent, fee);
    assert.equal(await read(arena, "totalChallenges"), 0n);
  });

  it("consumes a challenge ID once even if a second valid signature is issued", async () => {
    const value = await result(arena, "replay");
    await settle(arena, value);
    for (const changed of [value, { ...value, player: addressOf(recipient) }]) {
      await reverts(arena, "settleChallenge", [changed, await sign(arena, changed)], "ChallengeAlreadySettled", agent, fee);
    }
    assert.equal(await read(arena, "totalChallenges"), 1n);
  });

  it("binds the signature to the sending player and every EIP-712 domain", async () => {
    const value = await result(arena, "binding");
    const signature = await sign(arena, value);
    assert.equal(await read(arena, "hashResult", [value]), hashTypedData({ domain: domain(arena), types, primaryType: "ChallengeResult", message: value }));
    await reverts(arena, "settleChallenge", [value, signature], "WrongPlayer", attacker, fee);
    await reverts(arena, "settleChallenge", [{ ...value, player: addressOf(attacker) }, signature], "InvalidSignature", attacker, fee);
    for (const override of [{ chainId: 10143 }, { version: "2" }]) {
      await reverts(arena, "settleChallenge", [value, await sign(arena, value, owner, override)], "InvalidSignature", agent, fee);
    }
    const other = await deploy("RugArena", constructorArgs);
    await reverts(other, "settleChallenge", [value, signature], "InvalidSignature", agent, fee);
  });

  it("requires the exact configured fee and predefined scores", async () => {
    const value = await result(arena, "fee");
    const signature = await sign(arena, value);
    for (const valueSent of [0n, fee - 1n, fee + 1n]) {
      await reverts(arena, "settleChallenge", [value, signature], "IncorrectFee", agent, valueSent);
    }
    for (const override of [{ score: 11n }, { success: true, score: 999999n }]) {
      const invalid = { ...value, ...override };
      await reverts(arena, "settleChallenge", [invalid, await sign(arena, invalid)], "InvalidScore", agent, fee);
    }
  });

  it("rejects malformed IDs, empty transcripts and expired results", async () => {
    for (const [override, expected] of [[{ challengeId: zeroHash }, "InvalidChallenge"],
      [{ transcriptHash: zeroHash }, "InvalidChallenge"], [{ deadline: 1n }, "ResultExpired"]]) {
      const value = await result(arena, "invalid", override);
      await reverts(arena, "settleChallenge", [value, await sign(arena, value)], expected, agent, fee);
    }
  });

  it("prevents failures and other wallets from claiming a winner's reward", async () => {
    await settle(arena, await result(arena, "loser"));
    await reverts(arena, "claimReward", [1n], "NoReward");
    await settle(arena, await result(arena, "winner", { success: true }));
    await reverts(arena, "claimReward", [1n], "NoReward", attacker);
    const round = await read(arena, "getCurrentRound");
    assert.equal(round.reward, unit("8"));
    assert.equal(round.active, false);
    assert.equal(round.winner, addressOf(agent));
  });

  it("reserves and claims the calculated reward once, with verifiable event and balance", async () => {
    await fund(arena, unit("2"));
    const won = await settle(arena, await result(arena, "claim", { success: true }));
    assert.deepEqual(events(arena, won).map((event) => event.eventName), ["ChallengeSettled", "PrizePoolUpdated", "WinnerDeclared"]);
    assert.equal(await read(arena, "prizePool"), unit("5"));
    assert.equal(await read(arena, "reservedRewards"), unit("5"));
    const before = await publicClient.getBalance({ address: arena.address });
    const receipt = await send(arena, "claimReward", [1n]);
    assert.equal(receipt.status, "success");
    assert.equal(before - await publicClient.getBalance({ address: arena.address }), unit("5"));
    assert.equal(await read(arena, "reservedRewards"), 0n);
    assert.equal((await read(arena, "getCurrentRound")).rewardClaimed, true);
    assert.equal(events(arena, receipt)[0].eventName, "RewardClaimed");
    await reverts(arena, "claimReward", [1n], "RewardAlreadyClaimed");
  });

  it("pays only funded MON even with a 100 percent payout rule and no seed", async () => {
    const fullReward = await deploy("RugArena", [addressOf(owner), fee, 8000n, 10000n, 7200n]);
    await settle(fullReward, await result(fullReward, "no-overpay", { success: true }));
    const round = await read(fullReward, "getCurrentRound");
    assert.equal(round.reward, unit("8"));
    assert.ok(round.reward <= await publicClient.getBalance({ address: fullReward.address }));
    await send(fullReward, "claimReward", [1n]);
    assert.equal(await read(fullReward, "prizePool"), 0n);
    assert.equal(await publicClient.getBalance({ address: fullReward.address }), unit("2"));
    await assert.rejects(() => deploy("RugArena", [addressOf(owner), fee, 8000n, 10001n, 7200n]));
  });

  it("rejects settlement after a winner and rejects old-round signatures after reopening", async () => {
    const old = await result(arena, "late-player", { player: addressOf(recipient) });
    const signature = await sign(arena, old);
    await settle(arena, await result(arena, "first-winner", { success: true }));
    await reverts(arena, "settleChallenge", [old, signature], "RoundClosed", recipient, fee);
    assert.equal((await send(arena, "startGameRound", [], attacker)).status, "success");
    await reverts(arena, "settleChallenge", [old, signature], "WrongRound", recipient, fee);
    const changedRound = { ...old, roundId: 2n };
    await reverts(arena, "settleChallenge", [changedRound, signature], "InvalidSignature", recipient, fee);
  });

  it("expires a round and lets any player open the next public round", async () => {
    const round = await read(arena, "getCurrentRound");
    const old = await result(arena, "expired-round", { deadline: round.endsAt + 100n });
    await publicClient.request({ method: "evm_setNextBlockTimestamp", params: [Number(round.endsAt)] });
    await publicClient.request({ method: "evm_mine" });
    assert.equal((await read(arena, "getCurrentRound")).active, false);
    await reverts(arena, "settleChallenge", [old, await sign(arena, old)], "RoundClosed", agent, fee);
    await send(arena, "startGameRound", [], recipient);
    const next = await read(arena, "getCurrentRound");
    assert.equal(next.id, 2n);
    assert.equal(next.active, true);
  });

  it("keeps players' statistics independent and lists each wallet only once", async () => {
    await settle(arena, await result(arena, "a-first"));
    await settle(arena, await result(arena, "a-second"));
    await settle(arena, await result(arena, "b-first", { player: addressOf(recipient), success: true }), recipient);
    assert.deepEqual(await read(arena, "getPlayerStats", [addressOf(agent)]), { attempts: 2n, successes: 0n, score: 20n, wins: 0n });
    assert.deepEqual(await read(arena, "getPlayerStats", [addressOf(recipient)]), { attempts: 1n, successes: 1n, score: 100n, wins: 1n });
    assert.deepEqual(await read(arena, "getPlayers"), [addressOf(agent), addressOf(recipient)]);
    assert.equal(await read(arena, "totalChallenges"), 3n);
  });

  it("preserves past winners' reserves across later rounds and out-of-order claims", async () => {
    await settle(arena, await result(arena, "round-one", { success: true }));
    assert.equal(await read(arena, "reservedRewards"), unit("4"));
    await send(arena, "startGameRound", [], attacker);
    await settle(arena, await result(arena, "round-two", { player: addressOf(recipient), success: true }), recipient);
    assert.equal((await read(arena, "getRound", [1n])).reward, unit("4"));
    assert.equal((await read(arena, "getRound", [2n])).reward, unit("6"));
    assert.equal(await read(arena, "reservedRewards"), unit("10"));
    assert.equal(await read(arena, "prizePool"), unit("6"));
    await send(arena, "claimReward", [2n], recipient);
    await send(arena, "startGameRound", [], attacker);
    await send(arena, "claimReward", [1n], agent);
    assert.equal(await read(arena, "reservedRewards"), 0n);
    assert.equal(await read(arena, "prizePool"), unit("6"));
    assert.equal(await publicClient.getBalance({ address: arena.address }), unit("10"));
  });
});
