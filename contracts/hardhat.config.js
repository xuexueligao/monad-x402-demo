import { defineConfig } from "hardhat/config";

// Hardhat provides only the local EVM. compile.mjs uses the pinned npm solc,
// so tests and demos do not download a compiler at runtime.
export default defineConfig({
  networks: {
    local: {
      type: "edr-simulated",
      chainType: "l1",
      chainId: 31337,
      hardfork: "cancun",
      throwOnTransactionFailures: false,
      initialDate: "2026-10-17T05:00:00Z",
    },
  },
});
