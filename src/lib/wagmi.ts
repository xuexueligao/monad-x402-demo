import { createConfig, http } from 'wagmi';
import { injected, walletConnect } from 'wagmi/connectors';
import { defineChain } from 'viem';
import { TESTNET } from '../../shared/config';

export const monad = defineChain({
  id: TESTNET.chainId,
  name: TESTNET.name,
  nativeCurrency: { name: 'Monad', symbol: 'MON', decimals: 18 },
  rpcUrls: { default: { http: [process.env.NEXT_PUBLIC_MONAD_RPC_URL || TESTNET.rpc] } },
  blockExplorers: { default: { name: 'Monadscan', url: TESTNET.explorer } },
  testnet: true,
});
const walletConnectId = process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID?.trim();
export const walletConnectEnabled = Boolean(walletConnectId && /^[a-f\d]{32}$/i.test(walletConnectId));
export const wagmiConfig = createConfig({
  chains: [monad],
  connectors: [injected({ unstable_shimAsyncInject: 2000 }), ...(walletConnectEnabled && walletConnectId ? [walletConnect({ projectId: walletConnectId, showQrModal: true })] : [])],
  multiInjectedProviderDiscovery: true,
  transports: { [monad.id]: http(undefined, { batch: true, retryCount: 1 }) },
  ssr: true,
});
