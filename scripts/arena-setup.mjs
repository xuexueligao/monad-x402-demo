import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

const file = fileURLToPath(new URL('../.env.arena.local', import.meta.url));
if (existsSync(file)) {
  console.log('.env.arena.local 已存在，保留当前配置。');
} else {
  const key = generatePrivateKey();
  const template = readFileSync(new URL('../.env.example', import.meta.url), 'utf8');
  writeFileSync(file, template.replace(/^ARENA_RESULT_SIGNER_PRIVATE_KEY=.*$/m, `ARENA_RESULT_SIGNER_PRIVATE_KEY=${key}`), { mode: 0o600 });
  console.log('已生成 .env.arena.local；后端判定签名地址：', privateKeyToAccount(key).address);
  console.log('此密钥仅用于签游戏结果，不保管玩家资金。请在本机配置文件中填写部署密钥和 AI Key。');
}
mkdirSync(fileURLToPath(new URL('../.local/tmp/', import.meta.url)), { recursive: true });
