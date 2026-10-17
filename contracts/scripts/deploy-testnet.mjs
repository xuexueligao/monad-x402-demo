import fs from "node:fs/promises";
import path from "node:path";
import { createPublicClient, createWalletClient, http, getAddress, keccak256, encodeAbiParameters, parseAbiParameters } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { monadTestnet } from "viem/chains";
import { compile, ROOT } from "./compile.mjs";
import { parseDeploymentConfig, verifyDeployment, json } from "../lib/deployment.mjs";

const config = parseDeploymentConfig(process.env);
const privateKey = process.env.DRAGONBAIT_DEPLOYER_PRIVATE_KEY;
if (!/^0x[0-9a-fA-F]{64}$/.test(privateKey ?? "")) throw new Error("Set DRAGONBAIT_DEPLOYER_PRIVATE_KEY in contracts/.env.local");
const account = privateKeyToAccount(privateKey);
if (getAddress(account.address) !== config.owner) throw new Error("Deployment signer must equal configured owner for policy initialization");
const transport = http(process.env.DRAGONBAIT_RPC_URL ?? "https://testnet-rpc.monad.xyz", { timeout: 20_000, retryCount: 2 });
const publicClient = createPublicClient({ chain: monadTestnet, transport, cacheTime: 0, pollingInterval: 500 });
const walletClient = createWalletClient({ chain: monadTestnet, transport, account });
if (await publicClient.getChainId() !== 10143) throw new Error("Refusing deployment outside Monad TESTNET (10143)");
const artifacts = await compile();
const directory = path.join(ROOT, ".local", "deployments");
await fs.mkdir(directory, { recursive: true });
const output = path.join(directory, `monad-testnet-${Date.now()}.json`);
const manifest = {
  formatVersion: 1, status: "deploying", chainId: 10143, network: "Monad Testnet",
  createdAt: new Date().toISOString(), owner: config.owner, agent: config.agent,
  compiler: artifacts.PolicyVault.compiler, evmVersion: artifacts.PolicyVault.evmVersion,
  explorerBaseUrl: "https://testnet.monadscan.com",
  policy: { maxPerPayment: config.maxPerPayment, windowBudget: config.windowBudget, windowSeconds: config.windowSeconds, recipients: config.recipients },
  vaults: {}, transactions: [],
};
const save = () => fs.writeFile(output, json(manifest));
await save();
console.log(`Deployment progress is saved after each receipt: ${output}`);

async function receiptFor(hash, action) {
  // Save the hash BEFORE waiting. A disconnect must not erase an already sent tx.
  const entry = { action, transactionHash: hash, receiptStatus: "pending" };
  manifest.transactions.push(entry);
  await save();
  const receipt = await publicClient.waitForTransactionReceipt({ hash, confirmations: 1, timeout: 120_000 });
  Object.assign(entry, { receiptStatus: receipt.status, blockNumber: receipt.blockNumber, gasUsed: receipt.gasUsed });
  await save();
  if (receipt.status !== "success") throw new Error(`${action} reverted: ${hash}`);
  return receipt;
}

try {
  for (const [mode, name, args, constructorTypes] of [
    ["baseline", "UnrestrictedVault", [config.owner, config.agent], "address,address"],
    ["firewall", "PolicyVault", [config.owner, config.agent, config.maxPerPayment, config.windowBudget, config.windowSeconds], "address,address,uint256,uint256,uint64"],
  ]) {
    const { abi, bytecode } = artifacts[name];
    const receipt = await receiptFor(await walletClient.deployContract({ abi, bytecode, args }), `deploy:${mode}`);
    const address = receipt.contractAddress;
    if (!address) throw new Error(`Missing contract address for ${mode}`);
    const runtimeCode = await publicClient.getCode({ address });
    manifest.vaults[mode] = {
      address, contractName: name, sourceName: artifacts[name].sourceName,
      transactionHash: receipt.transactionHash, deploymentBlock: receipt.blockNumber,
      runtimeCodeHash: keccak256(runtimeCode), constructorArgs: args,
      constructorArgumentsEncoded: encodeAbiParameters(parseAbiParameters(constructorTypes), args),
    };
    await save();
    console.log(`${name}: https://testnet.monadscan.com/address/${address}`);
  }
  for (const recipient of config.recipients) {
    const hash = await walletClient.writeContract({ address: manifest.vaults.firewall.address, abi: artifacts.PolicyVault.abi,
      functionName: "setRecipient", args: [recipient, true] });
    await receiptFor(hash, `allow-recipient:${recipient}`);
  }
  // Zero by default. Funding is separate from fees, admission and game rules.
  if (config.seedEach > 0n) for (const mode of ["baseline", "firewall"]) {
    await receiptFor(await walletClient.sendTransaction({ to: manifest.vaults[mode].address, value: config.seedEach }), `fund:${mode}`);
  }
  manifest.policy.version = await publicClient.readContract({ address: manifest.vaults.firewall.address, abi: artifacts.PolicyVault.abi, functionName: "policyVersion" });
  manifest.status = "complete";
  await save();
  await verifyDeployment({ publicClient, manifest, artifacts });
  console.log(`Deployment verified. Manifest: ${output}`);
} catch (error) {
  manifest.status = "needs-attention";
  manifest.error = error.shortMessage ?? error.message;
  await save();
  console.error(`Deployment stopped. Check recorded hashes before re-running: ${output}`);
  throw error;
}
