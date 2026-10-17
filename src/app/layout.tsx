import type { Metadata } from "next";
import "./globals.css";
import { Providers } from "@/components/providers";
import '@fontsource-variable/space-grotesk';
import '@fontsource-variable/nunito-sans';

export const metadata: Metadata = {
  title: "MONAD RUG ARENA · 骗龙夺宝",
  description: "三句话，骗走小黄龙的金币。多人实时 AI 攻防竞技场，运行于 Monad Testnet。",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="zh-CN"><body><Providers>{children}</Providers></body></html>;
}
