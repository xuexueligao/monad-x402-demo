import assert from "node:assert/strict";
import { before, beforeEach, describe, it } from "node:test";
import { decodeEventLog, encodeFunctionData, hashTypedData, toHex, zeroAddress, zeroHash } from "viem";
import { publicClient, owner, agent, recipient, attacker, unit, id, addressOf, deploy, read, send, fund } from "./helpers.mjs";

const types = { ChallengeResult: [
  { name: "challengeId", type: "bytes32" }, { name: "player", type: "address" },
  { name: "roundId", type: "uint256" }, { name: "success", type: "bool" },
  { name: "score", type: "uint256" }, { name: "deadline", type: "uint256" },
  { name: "transcriptHash", type: "bytes32" },
] };
const fee = unit("10");
const constructorArgs = [addressOf(owner), fee, 8000n, 5000n, 7200n, 180n];
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
async function enter(arena, value, wallet = agent) {
  return send(arena, "enterChallenge", [value.challengeId, value.roundId], wallet, { value: fee });
}
async function settle(arena, value, wallet = attacker) {
  return send(arena, "settleChallenge", [value, await sign(arena, value)], wallet);
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

describe("RugArena: prepaid sessions and automatic rewards to the paying wallet", () => {
  let arena, snapshot;
  before(async () => {
    arena = await deploy("RugArena", constructorArgs);
    snapshot = await publicClient.request({ method: "evm_snapshot" });
  });
  beforeEach(async () => {
    assert.equal(await publicClient.request({ method: "evm_revert", params: [snapshot] }), true);
    snapshot = await publicClient.request({ method: "evm_snapshot" });
  });

  it("starts a two-hour public round with a three-minute challenge limit and no fabricated funds", async () => {
    const round = await read(arena, "getCurrentRound");
    assert.equal(round.id, 1n);
    assert.equal(round.challengeFee, fee);
    assert.equal(round.prizePool, 0n);
    assert.equal(round.active, true);
    assert.equal(round.winner, zeroAddress);
    assert.equal(await read(arena, "challengeDuration"), 180n);
    assert.equal(await read(arena, "resultSigner"), addressOf(owner));
    assert.equal(events(arena, arena.deploymentReceipt)[0].eventName, "GameRoundStarted");
    await reverts(arena, "startGameRound", [], "RoundStillActive");
  });

  it("records the actual payer, fee, round and expiry before dialogue or a verdict exists", async () => {
    const value = await result(arena, "prepaid");
    const receipt = await enter(arena, value);
    const challenge = await read(arena, "getChallenge", [value.challengeId]);
    const block = await publicClient.getBlock({ blockNumber: receipt.blockNumber });
    assert.equal(challenge.player, addressOf(agent));
    assert.equal(challenge.roundId, value.roundId);
    assert.equal(challenge.fee, fee);
    assert.equal(challenge.enteredAt, block.timestamp);
    assert.equal(challenge.expiresAt, block.timestamp + 180n);
    assert.equal(challenge.settled, false);
    assert.equal(challenge.transcriptHash, zeroHash);
    assert.deepEqual(await read(arena, "getPlayerStats", [addressOf(agent)]), { attempts: 1n, successes: 0n, score: 0n, wins: 0n });
    assert.equal(await read(arena, "totalChallenges"), 1n);
    assert.equal(await read(arena, "prizePool"), unit("8"));
    assert.equal(await publicClient.getBalance({ address: arena.address }), fee);
    const entered = events(arena, receipt);
    assert.deepEqual(entered.map((event) => event.eventName), ["ChallengeEntered", "PrizePoolUpdated"]);
    assert.equal(entered[0].args.player, addressOf(agent));
    assert.equal(entered[0].args.expiresAt, challenge.expiresAt);
  });

  it("requires the exact entry fee once and never accepts a second payment for a session", async () => {
    const value = await result(arena, "entry-fee");
    for (const amount of [0n, fee - 1n, fee + 1n]) {
      await reverts(arena, "enterChallenge", [value.challengeId, value.roundId], "IncorrectFee", agent, amount);
    }
    await reverts(arena, "enterChallenge", [zeroHash, value.roundId], "InvalidChallenge", agent, fee);
    await reverts(arena, "enterChallenge", [value.challengeId, 2n], "WrongRound", agent, fee);
    await enter(arena, value);
    await reverts(arena, "enterChallenge", [value.challengeId, value.roundId], "ChallengeAlreadyEntered", recipient, fee);
    await settle(arena, value);
    await reverts(arena, "enterChallenge", [value.challengeId, value.roundId], "ChallengeAlreadyEntered", agent, fee);
    assert.equal(await publicClient.getBalance({ address: arena.address }), fee);
  });

  it("allows the gas-paying backend to settle a paid failure without charging the player again", async () => {
    const value = await result(arena, "failure");
    await enter(arena, value);
    const payerBefore = await publicClient.getBalance({ address: addressOf(agent) });
    const receipt = await settle(arena, value, owner);
    assert.equal(receipt.status, "success");
    assert.equal(await publicClient.getBalance({ address: addressOf(agent) }), payerBefore);
    const challenge = await read(arena, "getChallenge", [value.challengeId]);
    assert.equal(challenge.settled, true);
    assert.equal(challenge.fee, fee);
    assert.equal(challenge.reward, 0n);
    assert.equal(challenge.transcriptHash, value.transcriptHash);
    assert.deepEqual(await read(arena, "getPlayerStats", [addressOf(agent)]), { attempts: 1n, successes: 0n, score: 10n, wins: 0n });
    assert.equal(await read(arena, "totalChallenges"), 1n);
    assert.equal(await read(arena, "prizePool"), unit("8"));
    assert.deepEqual(events(arena, receipt).map((event) => event.eventName), ["ChallengeSettled", "PrizePoolUpdated"]);
    await assert.rejects(() => publicClient.simulateContract({ address: arena.address, abi: arena.abi,
      functionName: "settleChallenge", args: [value, "0x"], account: owner.account, value: fee }));
  });

  it("rejects an unpaid result, invalid signature and a mutated model verdict", async () => {
    const value = await result(arena, "forged");
    const signature = await sign(arena, value);
    await reverts(arena, "settleChallenge", [value, signature], "ChallengeNotEntered");
    await enter(arena, value);
    for (const invalid of ["0x", await sign(arena, value, attacker)]) {
      await reverts(arena, "settleChallenge", [value, invalid], "InvalidSignature");
    }
    await reverts(arena, "settleChallenge", [{ ...value, success: true, score: 100n }, signature], "InvalidSignature");
    assert.equal((await read(arena, "getChallenge", [value.challengeId])).settled, false);
    assert.equal((await read(arena, "getPlayerStats", [addressOf(agent)])).score, 0n);
  });

  it("consumes a verdict once even if another valid signature is issued", async () => {
    const value = await result(arena, "replay");
    await enter(arena, value);
    await settle(arena, value);
    for (const changed of [value, { ...value, success: true, score: 100n }]) {
      await reverts(arena, "settleChallenge", [changed, await sign(arena, changed)], "ChallengeAlreadySettled");
    }
    assert.equal(await read(arena, "totalChallenges"), 1n);
    assert.equal((await read(arena, "getPlayerStats", [addressOf(agent)])).score, 10n);
  });

  it("binds every signature to the paid player, paid round and EIP-712 domain", async () => {
    const value = await result(arena, "binding");
    await enter(arena, value);
    assert.equal(await read(arena, "hashResult", [value]), hashTypedData({ domain: domain(arena), types, primaryType: "ChallengeResult", message: value }));
    for (const [override, errorName] of [[{ player: addressOf(attacker) }, "WrongPlayer"], [{ roundId: 2n }, "WrongRound"]]) {
      const changed = { ...value, ...override };
      await reverts(arena, "settleChallenge", [changed, await sign(arena, changed)], errorName, attacker);
    }
    for (const override of [{ chainId: 10143 }, { version: "2" }]) {
      await reverts(arena, "settleChallenge", [value, await sign(arena, value, owner, override)], "InvalidSignature");
    }
    const other = await deploy("RugArena", constructorArgs);
    await enter(other, value);
    await reverts(other, "settleChallenge", [value, await sign(arena, value)], "InvalidSignature");
  });

  it("rejects malformed transcripts, expired signatures and scores outside the fixed game rules", async () => {
    const original = await result(arena, "invalid");
    await enter(arena, original);
    for (const [override, expected] of [[{ challengeId: zeroHash }, "InvalidChallenge"],
      [{ transcriptHash: zeroHash }, "InvalidChallenge"], [{ deadline: 1n }, "ResultExpired"],
      [{ score: 11n }, "InvalidScore"], [{ success: true, score: 999999n }, "InvalidScore"]]) {
      const value = { ...original, ...override };
      await reverts(arena, "settleChallenge", [value, await sign(arena, value)], expected);
    }
  });

  it("automatically transfers the fixed pool share to the payer, never the relayer", async () => {
    await fund(arena, unit("2"));
    const value = await result(arena, "direct-reward", { success: true });
    await enter(arena, value);
    const payerBefore = await publicClient.getBalance({ address: addressOf(agent) });
    const arenaBefore = await publicClient.getBalance({ address: arena.address });
    const receipt = await settle(arena, value, attacker);
    assert.equal(await publicClient.getBalance({ address: addressOf(agent) }) - payerBefore, unit("5"));
    assert.equal(arenaBefore - await publicClient.getBalance({ address: arena.address }), unit("5"));
    assert.equal(await read(arena, "prizePool"), unit("5"));
    const round = await read(arena, "getCurrentRound");
    assert.equal(round.winner, addressOf(agent));
    assert.equal(round.reward, unit("5"));
    assert.equal(round.rewardClaimed, true);
    assert.equal(round.active, true);
    assert.deepEqual(events(arena, receipt).map((event) => event.eventName), ["RewardPaid", "WinnerDeclared", "ChallengeSettled", "PrizePoolUpdated"]);
    const paid = events(arena, receipt)[0];
    assert.equal(paid.args.player, addressOf(agent));
    assert.equal(paid.args.challengeId, value.challengeId);
    assert.equal(paid.args.amount, unit("5"));
    assert.ok(!arena.abi.some((entry) => entry.name === "claimReward"));
    await reverts(arena, "startGameRound", [], "RoundStillActive");
  });

  it("cannot pay more than the funded contract balance, including a 100 percent reward rule", async () => {
    const fullReward = await deploy("RugArena", [addressOf(owner), fee, 8000n, 10000n, 7200n, 180n]);
    const value = await result(fullReward, "full-reward", { success: true });
    await enter(fullReward, value);
    await publicClient.request({ method: "hardhat_setBalance", params: [fullReward.address, toHex(unit("1"))] });
    await reverts(fullReward, "settleChallenge", [value, await sign(fullReward, value)], "InsufficientAvailableBalance");
    assert.equal((await read(fullReward, "getChallenge", [value.challengeId])).settled, false);
    await publicClient.request({ method: "hardhat_setBalance", params: [fullReward.address, toHex(fee)] });
    const payerBefore = await publicClient.getBalance({ address: addressOf(agent) });
    await settle(fullReward, value);
    assert.equal(await publicClient.getBalance({ address: addressOf(agent) }) - payerBefore, unit("8"));
    assert.equal(await read(fullReward, "prizePool"), 0n);
    assert.equal(await publicClient.getBalance({ address: fullReward.address }), unit("2"));
    await assert.rejects(() => deploy("RugArena", [addressOf(owner), fee, 8000n, 10001n, 7200n, 180n]));
    await assert.rejects(() => deploy("RugArena", [...constructorArgs.slice(0, 5), 0n]));
  });

  it("keeps a rejected payout retryable with no consumed verdict or corrupted statistics", async () => {
    const payer = await deploy("ArenaPayer", []);
    const value = await result(arena, "reject-reward", { player: payer.address, success: true });
    await send(payer, "enter", [arena.address, value.challengeId, value.roundId], agent, { value: fee });
    await send(payer, "configureReward", [false, "0x"]);
    const signature = await sign(arena, value);
    await reverts(arena, "settleChallenge", [value, signature], "NativeTransferFailed");
    assert.equal((await read(arena, "getChallenge", [value.challengeId])).settled, false);
    assert.equal(await read(arena, "prizePool"), unit("8"));
    assert.deepEqual(await read(arena, "getPlayerStats", [payer.address]), { attempts: 1n, successes: 0n, score: 0n, wins: 0n });
    await send(payer, "configureReward", [true, "0x"]);
    await send(arena, "settleChallenge", [value, signature], attacker);
    assert.equal(await publicClient.getBalance({ address: payer.address }), unit("4"));
    assert.equal((await read(arena, "getChallenge", [value.challengeId])).settled, true);
  });

  it("blocks reentrant settlement of another paid session during automatic reward transfer", async () => {
    const payer = await deploy("ArenaPayer", []);
    const outer = await result(arena, "reentry-outer", { player: payer.address, success: true });
    const nested = await result(arena, "reentry-nested", { player: addressOf(recipient), success: true });
    await send(payer, "enter", [arena.address, outer.challengeId, outer.roundId], agent, { value: fee });
    await enter(arena, nested, recipient);
    const nestedCall = encodeFunctionData({ abi: arena.abi, functionName: "settleChallenge", args: [nested, await sign(arena, nested)] });
    await send(payer, "configureReward", [true, nestedCall]);
    await settle(arena, outer);
    assert.equal(await read(payer, "reentrySucceeded"), false);
    assert.equal((await read(arena, "getChallenge", [nested.challengeId])).settled, false);
    await settle(arena, nested);
    assert.equal((await read(arena, "getChallenge", [nested.challengeId])).settled, true);
  });

  it("allows concurrently paid players to finish independently after another player wins", async () => {
    const a = await result(arena, "simultaneous-a", { success: true });
    const b = await result(arena, "simultaneous-b", { player: addressOf(recipient), success: true });
    await enter(arena, a);
    await enter(arena, b, recipient);
    await settle(arena, a);
    assert.equal((await read(arena, "getCurrentRound")).active, true);
    await settle(arena, b);
    assert.equal((await read(arena, "getChallenge", [a.challengeId])).reward, unit("8"));
    assert.equal((await read(arena, "getChallenge", [b.challengeId])).reward, unit("4"));
    assert.equal(await read(arena, "prizePool"), unit("4"));
    assert.equal(await publicClient.getBalance({ address: arena.address }), unit("8"));
  });

  it("closes old-round entry but preserves a prepaid session when a new public round begins", async () => {
    const round = await read(arena, "getCurrentRound");
    await publicClient.request({ method: "evm_setNextBlockTimestamp", params: [Number(round.endsAt - 30n)] });
    await publicClient.request({ method: "evm_mine" });
    const old = await result(arena, "old-paid-round", { success: true });
    await enter(arena, old);
    await publicClient.request({ method: "evm_setNextBlockTimestamp", params: [Number(round.endsAt)] });
    await publicClient.request({ method: "evm_mine" });
    assert.equal((await read(arena, "getCurrentRound")).active, false);
    await reverts(arena, "enterChallenge", [id("late-unpaid"), 1n], "RoundClosed", agent, fee);
    await send(arena, "startGameRound", [], recipient);
    assert.equal((await read(arena, "getCurrentRound")).id, 2n);
    await reverts(arena, "enterChallenge", [id("wrong-round"), 1n], "WrongRound", agent, fee);
    const wrong = { ...old, roundId: 2n };
    await reverts(arena, "settleChallenge", [wrong, await sign(arena, wrong)], "WrongRound");
    await settle(arena, old);
    assert.equal((await read(arena, "getChallenge", [old.challengeId])).roundId, 1n);
    assert.equal((await read(arena, "getRound", [1n])).rewardClaimed, true);
    const current = await read(arena, "getCurrentRound");
    assert.equal(current.active, true);
    assert.equal(current.prizePool, unit("4"));
  });

  it("keeps player attempts, scores and wins independent and counts each wallet once", async () => {
    const a = await result(arena, "a-first");
    const a2 = await result(arena, "a-second");
    const b = await result(arena, "b-first", { player: addressOf(recipient), success: true });
    await enter(arena, a);
    await enter(arena, a2);
    await enter(arena, b, recipient);
    await settle(arena, a);
    await settle(arena, a2);
    await settle(arena, b);
    assert.deepEqual(await read(arena, "getPlayerStats", [addressOf(agent)]), { attempts: 2n, successes: 0n, score: 20n, wins: 0n });
    assert.deepEqual(await read(arena, "getPlayerStats", [addressOf(recipient)]), { attempts: 1n, successes: 1n, score: 100n, wins: 1n });
    assert.deepEqual(await read(arena, "getPlayers"), [addressOf(agent), addressOf(recipient)]);
    assert.equal(await read(arena, "totalChallenges"), 3n);
  });
});
