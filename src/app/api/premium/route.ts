import { NextResponse } from "next/server";
import { withX402 } from "@x402/next";
import { HTTPFacilitatorClient, x402ResourceServer } from "@x402/core/server";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { isAddress } from "viem";
import { TESTNET } from "@/lib/network";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const receiver = process.env.PAY_TO_ADDRESS;

const server = new x402ResourceServer(
  new HTTPFacilitatorClient({ url: TESTNET.facilitator }),
).register(TESTNET.network, new ExactEvmScheme());

export const GET = receiver && isAddress(receiver) ? withX402(
  async () => NextResponse.json({
    title: "你的第一次 x402 付款已完成",
    content: "这段内容来自受付款保护的服务端接口。只有支付验证和结算成功后，接口才会把结果返回给你。下一步可以把这里替换成 AI 生成的文案或报告。",
    unlockedAt: new Date().toISOString(),
    network: TESTNET.network,
  }, { headers: { "Cache-Control": "no-store" } }),
  {
    resource: process.env.PUBLIC_DEMO_URL ? new URL("/api/premium", process.env.PUBLIC_DEMO_URL).toString() : undefined,
    accepts: {
      scheme: "exact",
      network: TESTNET.network,
      payTo: receiver,
      price: {
        amount: TESTNET.amount,
        asset: TESTNET.usdc,
        extra: { name: "USDC", version: "2" },
      },
    },
    description: "Monad 测试网 x402 付款示例",
    mimeType: "application/json",
  },
  server,
) : async () => NextResponse.json(
  {
    error: "LEGACY_X402_NOT_CONFIGURED",
    message: "旧 x402 示例尚未配置有效的 PAY_TO_ADDRESS；MONAD RUG ARENA 游戏不受影响。",
  },
  { status: 503, headers: { "Cache-Control": "no-store" } },
);
