import { NextResponse } from "next/server";
import { isAddress } from "viem";
import { TESTNET } from "@/lib/network";

export const dynamic = "force-dynamic";

export function GET() {
  const receiver = process.env.PAY_TO_ADDRESS ?? "";
  return NextResponse.json({
    ...TESTNET,
    receiver,
    configured: isAddress(receiver),
  }, { headers: { "Cache-Control": "no-store" } });
}
