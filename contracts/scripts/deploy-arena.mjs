import fs from "node:fs/promises";
import path from "node:path";
import { createPublicClient, createWalletClient, defineChain, encodeAbiParameters, getAddress, http, keccak256, parseEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { compile, ROOT } from "./compile.mjs";
import { assertCompiledRuntime } from "../lib/deployment.mjs";

const projectRoot = path.resolve(ROOT, "..");
const network = JSON.parse(await fs.readFile(path.join(projectRoot, "shared", "network.json"), "utf8"));
if (network.chainId !== 10143 || (process.env.ARENA_CHAIN_ID && process.env.ARENA_CHAIN_ID !== "10143")) {
  throw new Error("Rug Arena deployments support only Monad Testnet (10143).");
}
const tempDirectory = path.join(projectRoot, ".local", "tmp");
await fs.mkdir(tempDirectory, { recursive: true });
process.env.TEMP = tempDirectory;
process.env.TMP = tempDirectory;

const json = (value) => `${JSON.stringify(value, (_, item) => typeof item === "bigint" ? item.toString() : item, 2)}\n`;
function integer(name, fallback, min, max) {
  const value = process.env[name] || String(fallback);
  if (!/^\d+$/.test(value)) throw new Error(`${name} must be a positive integer.`);
  const parsed = BigInt(value);
  if (parsed < min || parsed > max) throw new Error(`${name} must be between ${min} and ${max}.`);
  return parsed;
}
function mon(name, fallback, allowZero = false) {
  const value = process.env[name] || fallback;
  if (!/^\d+(\.\d{1,18})?$/.test(value)) throw new Error(`${name} must be a MON amount with at most 18 decimal places.`);
  const amount = parseEther(value);
  if (!allowZero && amount === 0n) throw new Error(`${name} must be greater than zero.`);
  return amount;
}

async function main() {
  const key = process.env.ARENA_DEPLOYER_PRIVATE_KEY;
  if (!/^0x[0-9a-fA-F]{64}$/.test(key || "")) {
    throw new Error("Set ARENA_DEPLOYER_PRIVATE_KEY in the project's .env.arena.local. Existing wallet files are never read by this script.");
  }
  const account = privateKeyToAccount(key);
  const resultKey = process.env.ARENA_RESULT_SIGNER_PRIVATE_KEY;
  const derivedSigner = /^0x[0-9a-fA-F]{64}$/.test(resultKey || "") ? privateKeyToAccount(resultKey).address : undefined;
  const signerInput = process.env.ARENA_RESULT_SIGNER_ADDRESS || derivedSigner;
  if (!signerInput) throw new Error("Set ARENA_RESULT_SIGNER_ADDRESS, or the backend's ARENA_RESULT_SIGNER_PRIVATE_KEY.");
  const resultSigner = getAddress(signerInput);
  if (derivedSigner && getAddress(derivedSigner) !== resultSigner) throw new Error("Result signer address differs from the configured backend signer.");
  const challengeFee = mon("ARENA_CHALLENGE_FEE_MON", "10");
  const poolShareBps = integer("ARENA_POOL_SHARE_BPS", 8000, 0n, 10000n);
  const rewardBps = integer("ARENA_REWARD_BPS", 5000, 1n, 10000n);
  const roundDuration = integer("ARENA_ROUND_DURATION_SECONDS", 7200, 1n, 31_536_000n);
  const challengeDuration = integer("ARENA_CHALLENGE_DURATION_SECONDS", 180, 1n, 86400n);
  const seed = mon("ARENA_SEED_MON", "0", true);
  const rpcUrl = process.env.ARENA_RPC_URL || process.env.MONAD_RPC_URL || network.rpc;
  const chain = defineChain({ id: network.chainId, name: network.name,
    nativeCurrency: { name: network.currency, symbol: network.currency, decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } }, blockExplorers: { default: { name: "Monadscan", url: network.explorer } }, testnet: true });
  const transport = http(rpcUrl, { timeout: 20_000, retryCount: 2 });
  const publicClient = createPublicClient({ chain, transport, cacheTime: 0, pollingInterval: 1000 });
  const walletClient = createWalletClient({ chain, transport, account });
  if (await publicClient.getChainId() !== 10143) throw new Error("RPC chainId differs from Monad Testnet (10143); deployment stopped.");
  const directory = path.join(projectRoot, "deployments");
  await fs.mkdir(directory, { recursive: true });
  const output = path.join(directory, "monad-testnet.json");
  const previous = await fs.readFile(output, "utf8").then(JSON.parse).catch((error) => {
    if (error.code !== "ENOENT") throw error;
    return null;
  });
  if (previous?.transactionHash) {
    console.log(`A deployment transaction is already recorded: ${network.explorer}/tx/${previous.transactionHash}`);
    console.log(`Use the existing manifest at ${output}; archive it explicitly before creating a different deployment.`);
    return;
  }
  const artifact = (await compile()).RugArena;
  const constructorArgs = [resultSigner, challengeFee, poolShareBps, rewardBps, roundDuration, challengeDuration];
  const manifest = {
    formatVersion: 2, gameFlow: "prepaid-auto-payout", status: "prepared", chainId: 10143, network: network.name,
    createdAt: new Date().toISOString(), deployer: account.address, resultSigner,
    contractName: "RugArena", sourceName: artifact.sourceName, compiler: artifact.compiler, evmVersion: artifact.evmVersion,
    explorerBaseUrl: network.explorer, constructorArgs,
    constructorArgumentsEncoded: encodeAbiParameters([{ type: "address" }, ...Array.from({ length: 5 }, () => ({ type: "uint256" }))], constructorArgs),
    settings: { challengeFee, poolShareBps, rewardBps, roundDuration, challengeDuration, seed },
  };
  const save = () => fs.writeFile(output, json(manifest));
  await save();
  try {
    const hash = await walletClient.deployContract({ abi: artifact.abi, bytecode: artifact.bytecode, args: constructorArgs, value: seed });
    Object.assign(manifest, { status: "submitted", transactionHash: hash, transactionUrl: `${network.explorer}/tx/${hash}` });
    await save();
    console.log(`Deployment submitted: ${manifest.transactionUrl}`);
    const receipt = await publicClient.waitForTransactionReceipt({ hash, confirmations: 1, timeout: 120_000 });
    Object.assign(manifest, { receiptStatus: receipt.status, deploymentBlock: receipt.blockNumber, gasUsed: receipt.gasUsed });
    await save();
    if (receipt.status !== "success" || !receipt.contractAddress) throw new Error("Deployment transaction reverted. Its hash is saved in the manifest.");
    const address = getAddress(receipt.contractAddress);
    const code = await publicClient.getCode({ address });
    assertCompiledRuntime(code, artifact);
    const [actualSigner, actualFee, actualChallengeDuration, round] = await Promise.all([
      publicClient.readContract({ address, abi: artifact.abi, functionName: "resultSigner" }),
      publicClient.readContract({ address, abi: artifact.abi, functionName: "challengeFee" }),
      publicClient.readContract({ address, abi: artifact.abi, functionName: "challengeDuration" }),
      publicClient.readContract({ address, abi: artifact.abi, functionName: "getCurrentRound" }),
    ]);
    if (getAddress(actualSigner) !== resultSigner || actualFee !== challengeFee || actualChallengeDuration !== challengeDuration || round.id !== 1n || round.prizePool !== seed) {
      throw new Error("Deployed contract state differs from configured game settings.");
    }
    Object.assign(manifest, { status: "complete", address, contractAddress: address, runtimeCodeHash: keccak256(code), contractUrl: `${network.explorer}/address/${address}` });
    await save();
    console.log(`RugArena verified: ${manifest.contractUrl}`);
    console.log(`Public deployment manifest: ${output}`);
    console.log(`ARENA_CONTRACT_ADDRESS=${address}\nNEXT_PUBLIC_ARENA_CONTRACT_ADDRESS=${address}\nARENA_DEPLOYMENT_BLOCK=${receipt.blockNumber}`);
  } catch (error) {
    manifest.status = "needs-attention";
    manifest.error = error.shortMessage || error.message;
    await save();
    throw error;
  }
}

try { await main(); } catch (error) {
  console.error(error.shortMessage || error.message);
  process.exitCode = 1;
}
