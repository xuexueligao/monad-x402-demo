import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import solc from "solc";

export const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const require = createRequire(import.meta.url);

export async function compile({ quiet = false } = {}) {
  const sourceNames = [
    "src/NativeVault.sol", "src/UnrestrictedVault.sol", "src/PolicyVault.sol", "src/RugArena.sol",
    "test/fixtures/Receivers.sol",
  ];
  const sources = Object.fromEntries(await Promise.all(sourceNames.map(async (name) => [
    name, { content: await fs.readFile(path.join(ROOT, name), "utf8") },
  ])));
  const input = {
    language: "Solidity",
    sources,
    settings: {
      optimizer: { enabled: true, runs: 200 },
      evmVersion: "cancun",
      metadata: { bytecodeHash: "ipfs" },
      outputSelection: { "*": { "*": ["abi", "evm.bytecode.object", "evm.deployedBytecode.object", "evm.deployedBytecode.immutableReferences", "metadata"] } },
    },
  };
  const imports = {};
  const output = JSON.parse(solc.compile(JSON.stringify(input), {
    import: (name) => {
      if (!name.startsWith("@openzeppelin/contracts/")) return { error: `Unsupported import: ${name}` };
      try {
        const content = require("node:fs").readFileSync(require.resolve(name), "utf8");
        imports[name] = { content };
        return { contents: content };
      } catch { return { error: `Import not found: ${name}` }; }
    },
  }));
  for (const diagnostic of output.errors ?? []) {
    if (diagnostic.severity === "error" || !quiet) console.error(diagnostic.formattedMessage);
  }
  if (output.errors?.some((error) => error.severity === "error")) throw new Error("Solidity compilation failed");
  const artifacts = {};
  await fs.mkdir(path.join(ROOT, "artifacts"), { recursive: true });
  await fs.mkdir(path.join(ROOT, "abi"), { recursive: true });
  for (const sourceName of sourceNames) {
    for (const [contractName, compiled] of Object.entries(output.contracts[sourceName] ?? {})) {
      const artifact = {
        contractName, sourceName, compiler: solc.version(), evmVersion: input.settings.evmVersion,
        abi: compiled.abi,
        bytecode: `0x${compiled.evm.bytecode.object}`,
        deployedBytecode: `0x${compiled.evm.deployedBytecode.object}`,
        immutableReferences: compiled.evm.deployedBytecode.immutableReferences,
      };
      artifacts[contractName] = artifact;
      await fs.writeFile(path.join(ROOT, "artifacts", `${contractName}.json`), `${JSON.stringify(artifact, null, 2)}\n`);
      if (["UnrestrictedVault", "PolicyVault", "RugArena"].includes(contractName)) {
        await fs.writeFile(path.join(ROOT, "abi", `${contractName}.json`), `${JSON.stringify(compiled.abi, null, 2)}\n`);
      }
    }
  }
  // A fully expanded Standard JSON input is suitable for explorer verification.
  input.sources = { ...sources, ...imports };
  await fs.writeFile(path.join(ROOT, "artifacts", "standard-input.json"), `${JSON.stringify(input, null, 2)}\n`);
  if (!quiet) console.log(`Compiled ${Object.keys(artifacts).length} contracts with ${solc.version()} (EVM cancun).`);
  return artifacts;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await compile();
}
