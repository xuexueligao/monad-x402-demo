'use client';
import { useState, type ReactNode } from 'react';
import { WagmiProvider } from 'wagmi';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { wagmiConfig } from '@/lib/wagmi';
import { ArenaProvider } from '@/lib/arena-context';

export function Providers({ children }: { children: ReactNode }) {
  const [queryClient] = useState(() => new QueryClient({ defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } } }));
  return <WagmiProvider config={wagmiConfig}><QueryClientProvider client={queryClient}><ArenaProvider>{children}</ArenaProvider></QueryClientProvider></WagmiProvider>;
}
