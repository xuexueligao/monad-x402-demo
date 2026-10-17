import fs from "node:fs/promises";
import { createPublicClient, http } from "viem";
import { compile } from "./compile.mjs";
import { verifyDeployment, json } from "../lib/deployment.mjs";

const manifestPath = process.argv[2];
if (!manifestPath) throw new Error("Usage: npm run verify:deployment -- path/to/manifest.json [rpc-url]");
const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
const rpcUrl = process.argv[3] ?? process.env.DRAGONBAIT_RPC_URL ?? (manifest.chainId === 10143 ? "https://testnet-rpc.monad.xyz" : undefined);
if (!rpcUrl) throw new Error("Supply the RPC URL for this manifest's chain");
const artifacts = await compile({ quiet: true });
const publicClient = createPublicClient({ transport: http(rpcUrl), cacheTime: 0 });
console.log(json(await verifyDeployment({ publicClient, manifest, artifacts })));
