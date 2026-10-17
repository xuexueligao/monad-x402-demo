import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  devIndicators: false,
  output: 'standalone',
  outputFileTracingExcludes: {
    '*': ['./.local/**/*', './.env*', './contracts/.local/**/*'],
  },
};

export default nextConfig;
