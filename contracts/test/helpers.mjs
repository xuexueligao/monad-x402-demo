import fs from "node:fs/promises";
import { createPublicClient, createWalletClient, http, keccak256, toHex, parseEther, getAddress } from "viem";
import { hardhat } from "viem/chains";

export const rpcUrl = process.env.DRAGONBAIT_LOCAL_RPC;
if (!rpcUrl || !/^http:\/\/127\.0\.0\.1:\d+$/.test(rpcUrl)) throw new Error("Tests require the owned loopback node from npm test/demo");
export const publicClient = createPublicClient({ chain: hardhat, transport: http(rpcUrl), pollingInterval: 20, cacheTime: 0 });
if (await publicClient.getChainId() !== 31337) throw new Error("Refusing test actions on a non-local chain");
const accounts = await publicClient.request({ method: "eth_accounts" });
export const [owner, agent, recipient, attacker, nextOwner, nextAgent] = accounts.map((account) =>
  createWalletClient({ account, chain: hardhat, transport: http(rpcUrl), pollingInterval: 20 }),
);
export const unit = parseEther;
export const id = (label) => keccak256(toHex(label));
export const addressOf = (wallet) => getAddress(wallet.account.address);
export async function artifact(name) {
  return JSON.parse(await fs.readFile(new URL(`../artifacts/${name}.json`, import.meta.url), "utf8"));
}
export async function deploy(name, args, wallet = owner) {
  const compiled = await artifact(name);
  const hash = await wallet.deployContract({ ...compiled, args });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success" || !receipt.contractAddress) throw new Error(`Failed to deploy ${name}`);
  return { ...compiled, address: receipt.contractAddress, deploymentReceipt: receipt };
}
export async function read(vault, functionName, args = []) {
  return publicClient.readContract({ address: vault.address, abi: vault.abi, functionName, args });
}
export async function send(vault, functionName, args = [], wallet = agent, extra = {}) {
  const hash = await wallet.writeContract({ address: vault.address, abi: vault.abi, functionName, args, ...extra });
  return publicClient.waitForTransactionReceipt({ hash });
}
export async function fund(vault, amount = unit("10")) {
  const hash = await owner.sendTransaction({ to: vault.address, value: amount });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error("Funding failed");
  return receipt;
}
export async function request(label, overrides = {}) {
  const block = await publicClient.getBlock();
  return {
    requestId: id(label), recipient: addressOf(recipient), amount: unit("0.1"),
    contextHash: id(`context:${label}`), deadline: block.timestamp + 3600n, ...overrides,
  };
}
export async function fixture({ max = "1", budget = "2", window = 86400n, balance = "10", allow = true } = {}) {
  const args = [addressOf(owner), addressOf(agent)];
  const baseline = await deploy("UnrestrictedVault", args);
  const firewall = await deploy("PolicyVault", [...args, unit(max), unit(budget), window]);
  if (balance !== "0") { await fund(baseline, unit(balance)); await fund(firewall, unit(balance)); }
  if (allow) await send(firewall, "setRecipient", [addressOf(recipient), true], owner);
  return { baseline, firewall };
}
