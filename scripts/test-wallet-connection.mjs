import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getAvailableInjectedWallets, getWalletOpenLinks } from '../src/lib/wallet-discovery.ts';

const wallet = (id, provider, extra = {}) => ({ id, name: id, type: 'injected', getProvider: async () => provider, ...extra });

test('a registered injected connector without an installed wallet is not offered', async () => {
  assert.deepEqual(await getAvailableInjectedWallets([wallet('injected', undefined)]), []);
});

test('EIP-6963 discovery and the generic connector do not duplicate the same wallet', async () => {
  const provider = { request: async () => [] };
  const named = wallet('io.metamask', provider);
  const found = await getAvailableInjectedWallets([wallet('injected', provider), named]);
  assert.deepEqual(found, [named]);
});

test('separate installed wallets remain selectable instead of connecting an arbitrary wallet', async () => {
  const metamask = wallet('io.metamask', { request: async () => [] });
  const rabby = wallet('io.rabby', { request: async () => [] });
  assert.deepEqual(await getAvailableInjectedWallets([metamask, rabby]), [metamask, rabby]);
});

test('one broken provider does not hide another wallet or initialize WalletConnect', async () => {
  let remoteCalls = 0;
  const good = wallet('io.metamask', { request: async () => [] });
  const found = await getAvailableInjectedWallets([
    wallet('broken', null, { getProvider: async () => { throw Error('Unavailable extension'); } }),
    wallet('invalid', {}), good,
    wallet('walletConnect', null, { type: 'walletConnect', getProvider: async () => { remoteCalls++; } }),
  ]);
  assert.deepEqual(found, [good]);
  assert.equal(remoteCalls, 0);
});

test('wallet app links use the current public game domain without private route, query, or fragment', () => {
  const links = getWalletOpenLinks('https://arena.example/tx/private?token=private-token#private-fragment');
  assert.equal(links.gameUrl, 'https://arena.example/play');
  assert.equal(links.metamask, 'https://metamask.app.link/dapp/arena.example/play');
  const trust = new URL(links.trust);
  assert.equal(trust.origin, 'https://link.trustwallet.com');
  assert.equal(trust.searchParams.get('url'), links.gameUrl);
  assert.equal(trust.searchParams.get('coin_id'), '60');
  assert(!JSON.stringify(links).includes('private'));
});
