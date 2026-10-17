import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Monad · 第一次 x402 付款",
  description: "在 Monad 测试网上，用 0.001 测试 USDC 解锁服务端内容。",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="zh-CN"><body>{children}</body></html>;
}
