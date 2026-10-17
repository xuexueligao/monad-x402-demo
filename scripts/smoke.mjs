import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { decodePaymentRequiredHeader } from "@x402/core/http";

const base = process.env.DEMO_URL || "http://127.0.0.1:3143";
const checks = [];
const request = (path, options = {}) => fetch(`${base}${path}`, { ...options, signal: AbortSignal.timeout(35_000) });

const home = await request("/");
assert.equal(home.status, 200);
assert.match(await home.text(), /付一次测试币/);
checks.push("首页返回 200，包含示例界面");

const configResponse = await request("/api/config");
assert.equal(configResponse.status, 200);
const config = await configResponse.json();
assert.equal(config.chainId, 10143);
assert.equal(config.network, "eip155:10143");
assert.equal(config.configured, true);
checks.push("网络固定为 Monad Testnet，收款地址有效");

const unpaid = await request("/api/premium");
assert.equal(unpaid.status, 402, `未付款接口应返回 402，实际为 ${unpaid.status}`);
const required = decodePaymentRequiredHeader(unpaid.headers.get("payment-required"));
assert.equal(required.x402Version, 2);
assert.equal(required.accepts.length, 1);
const accepted = required.accepts[0];
assert.equal(accepted.network, config.network);
assert.equal(accepted.scheme, "exact");
assert.equal(accepted.amount, "1000");
assert.equal(accepted.asset.toLowerCase(), config.usdc.toLowerCase());
assert.equal(accepted.payTo.toLowerCase(), config.receiver.toLowerCase());
assert.equal(accepted.extra.name, "USDC");
assert.equal(accepted.extra.version, "2");
if (base.startsWith("https://")) assert.equal(required.resource.url, new URL("/api/premium", base).toString());
assert.equal((await unpaid.text()).includes("你的第一次 x402 付款已完成"), false);
checks.push("未付款返回 x402 v2 要求：0.001 测试 USDC，且不泄露付费内容");

const malformed = await request("/api/premium", { headers: { "payment-signature": "invalid-base64-json" } });
assert.ok([400, 402].includes(malformed.status), `无效签名不应获得内容或导致服务崩溃，实际为 ${malformed.status}`);
assert.equal((await malformed.text()).includes("你的第一次 x402 付款已完成"), false);
checks.push("无效付款凭证被拒绝，不返回付费内容");

const wrongMethod = await request("/api/premium", { method: "POST" });
assert.equal(wrongMethod.status, 405);
checks.push("未实现的请求方法返回 405");

const result = { testedAt: new Date().toISOString(), base, passed: checks, paymentRequired: required };
mkdirSync(".local/evidence", { recursive: true });
writeFileSync(".local/evidence/smoke.json", JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
