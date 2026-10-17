import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

mkdirSync(".local", { recursive: true });
const file = ".local/test-wallets.json";
let wallets;
if (existsSync(file)) {
  wallets = JSON.parse(readFileSync(file, "utf8"));
} else {
  const payerKey = generatePrivateKey();
  const receiverKey = generatePrivateKey();
  wallets = {
    purpose: "Dedicated Monad testnet demo wallets. Never use with mainnet funds.",
    payer: { address: privateKeyToAccount(payerKey).address, privateKey: payerKey },
    receiver: { address: privateKeyToAccount(receiverKey).address, privateKey: receiverKey },
  };
  writeFileSync(file, JSON.stringify(wallets, null, 2), { mode: 0o600 });
}
if (!existsSync(".env.local")) {
  writeFileSync(".env.local", `PAY_TO_ADDRESS=${wallets.receiver.address}\n`, { mode: 0o600 });
}
console.log(JSON.stringify({
  payer: wallets.payer.address,
  receiver: wallets.receiver.address,
  fundPayerAt: "https://faucet.circle.com/ (USDC / Monad Testnet)",
  secretStorage: ".local/test-wallets.json (git ignored; private keys are not printed)",
}, null, 2));
