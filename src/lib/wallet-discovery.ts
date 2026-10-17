import type { Connector } from 'wagmi';

/** Registered injected connectors are only candidates until an actual provider exists. */
export async function getAvailableInjectedWallets(connectors: readonly Connector[]): Promise<Connector[]> {
  // EIP-6963 names take precedence over the generic window.ethereum connector.
  const candidates = connectors.filter(connector => connector.type === 'injected')
    .sort((a, b) => Number(a.id === 'injected') - Number(b.id === 'injected'));
  const results = await Promise.allSettled(candidates.map(async connector => ({ connector, provider: await connector.getProvider() })));
  const providers = new Set<unknown>(), identities = new Set<string>();
  const available: Connector[] = [];
  for (const result of results) {
    if (result.status !== 'fulfilled') continue;
    const { connector, provider } = result.value;
    if (!provider || typeof (provider as { request?: unknown }).request !== 'function' || providers.has(provider) || identities.has(connector.id)) continue;
    providers.add(provider); identities.add(connector.id); available.push(connector);
  }
  return available;
}

/** Share only the public game entrance, never the current route/query or private challenge state. */
export function getWalletOpenLinks(origin: string) {
  const game = new URL('/play', new URL(origin).origin);
  const gameUrl = game.href;
  return {
    gameUrl,
    // MetaMask's official dapp link format uses the host/path without https://.
    metamask: `https://metamask.app.link/dapp/${game.host}${game.pathname}`,
    trust: `https://link.trustwallet.com/open_url?coin_id=60&url=${encodeURIComponent(gameUrl)}`,
  };
}

export function walletDisplayName(connector: Connector) {
  return connector.id === 'injected' ? '浏览器钱包' : connector.name;
}
