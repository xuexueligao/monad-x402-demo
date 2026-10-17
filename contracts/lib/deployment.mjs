import { getAddress, keccak256, parseEther, isAddress } from "viem";
import { readVaultState } from "./payments.mjs";

export const json = (value) => `${JSON.stringify(value, (_, item) => typeof item === "bigint" ? item.toString() : item, 2)}\n`;

export function parseDeploymentConfig(env) {
  const required = ["DRAGONBAIT_OWNER_ADDRESS", "DRAGONBAIT_AGENT_ADDRESS", "DRAGONBAIT_MAX_PAYMENT_MON", "DRAGONBAIT_WINDOW_BUDGET_MON", "DRAGONBAIT_WINDOW_SECONDS"];
  for (const key of required) if (!env[key]) throw new Error(`Missing ${key}`);
  const owner = getAddress(env.DRAGONBAIT_OWNER_ADDRESS), agent = getAddress(env.DRAGONBAIT_AGENT_ADDRESS);
  if (!isAddress(owner, { strict: true }) || !isAddress(agent, { strict: true }) || /^0x0{40}$/i.test(owner) || /^0x0{40}$/i.test(agent)) {
    throw new Error("Owner and agent must be nonzero addresses");
  }
  if (owner === agent) throw new Error("Owner and agent must be separate");
  const decimal = (value, name, allowZero = false) => {
    if (typeof value !== "string" || !/^(0|[1-9]\d*)(\.\d{1,18})?$/.test(value)) throw new Error(`Invalid ${name}`);
    const amount = parseEther(value);
    if ((!allowZero && amount === 0n) || amount >= 2n ** 256n) throw new Error(`Invalid ${name}`);
    return amount;
  };
  const maxPerPayment = decimal(env.DRAGONBAIT_MAX_PAYMENT_MON, "single limit");
  const windowBudget = decimal(env.DRAGONBAIT_WINDOW_BUDGET_MON, "window budget");
  if (maxPerPayment > windowBudget) throw new Error("Single limit exceeds window budget");
  if (!/^\d+$/.test(env.DRAGONBAIT_WINDOW_SECONDS)) throw new Error("Invalid window seconds");
  const windowSeconds = BigInt(env.DRAGONBAIT_WINDOW_SECONDS);
  if (windowSeconds <= 0n || windowSeconds >= 2n ** 64n) throw new Error("Invalid window seconds");
  const recipients = [...new Set((env.DRAGONBAIT_ALLOWED_RECIPIENTS ?? "").split(",").map((s) => s.trim()).filter(Boolean).map((address) => getAddress(address)))];
  if (recipients.some((address) => /^0x0{40}$/i.test(address))) throw new Error("Invalid allowed recipient");
  return { owner, agent, maxPerPayment, windowBudget, windowSeconds, recipients,
    seedEach: decimal(env.DRAGONBAIT_SEED_EACH_MON ?? "0", "seed funds", true) };
}

function normalizedRuntime(code, immutableReferences) {
  const bytes = Buffer.from(code.slice(2), "hex");
  for (const slots of Object.values(immutableReferences ?? {})) {
    for (const { start, length } of slots) bytes.fill(0, start, start + length);
  }
  return `0x${bytes.toString("hex")}`;
}

export function assertCompiledRuntime(actualCode, compiled) {
  const expected = normalizedRuntime(compiled.deployedBytecode, compiled.immutableReferences);
  const actual = normalizedRuntime(actualCode, compiled.immutableReferences);
  if (expected !== actual) throw new Error(`Runtime does not match compiled ${compiled.contractName}`);
}

/** Read-only verification; detects wrong chain, swapped modes and code changes. */
export async function verifyDeployment({ publicClient, manifest, artifacts }) {
  if (await publicClient.getChainId() !== manifest.chainId) throw new Error("Deployment chain mismatch");
  if (manifest.status !== "complete") throw new Error("Deployment manifest is incomplete");
  const seen = new Set(), results = [];
  for (const [mode, contractName] of [["baseline", "UnrestrictedVault"], ["firewall", "PolicyVault"]]) {
    const item = manifest.vaults[mode], address = getAddress(item.address);
    if (seen.has(address)) throw new Error("Duplicate vault addresses");
    seen.add(address);
    const runtimeCode = await publicClient.getCode({ address });
    if (!runtimeCode || runtimeCode === "0x") throw new Error(`No code at ${address}`);
    if (keccak256(runtimeCode) !== item.runtimeCodeHash) throw new Error(`Runtime hash mismatch for ${mode}`);
    assertCompiledRuntime(runtimeCode, artifacts[contractName]);
    const state = await readVaultState(publicClient, address, mode);
    if (getAddress(state.owner) !== getAddress(manifest.owner) || getAddress(state.agent) !== getAddress(manifest.agent)) {
      throw new Error(`Authority drift for ${mode}`);
    }
    if (mode === "firewall") {
      if (state.policyVersion !== BigInt(manifest.policy.version)) throw new Error("Policy drift: policyVersion");
      for (const field of ["maxPerPayment", "windowBudget", "windowSeconds"]) {
        if (state[field] !== BigInt(manifest.policy[field])) throw new Error(`Policy drift: ${field}`);
      }
      for (const recipient of manifest.policy.recipients) {
        if (!await publicClient.readContract({ address, abi: artifacts[contractName].abi, functionName: "recipientAllowed", args: [recipient] })) {
          throw new Error(`Recipient permission drift: ${recipient}`);
        }
      }
    }
    results.push(state);
  }
  return results;
}
