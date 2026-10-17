import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright';

const base = process.env.ARENA_BROWSER_URL || 'http://localhost:3150';
const directory = '.local/evidence';
mkdirSync(directory, { recursive: true });
const checks = [];
const errors = [];
const browser = await chromium.launch({ channel: 'msedge', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 });
  page.on('pageerror', error => errors.push(error.message));
  for (const [route, name] of [['/', 'landing'], ['/play', 'play'], ['/arena', 'arena'], ['/leaderboard', 'leaderboard'], [`/tx/0x${'0'.repeat(64)}`, 'tx-unknown']]) {
    await page.goto(`${base}${route}`, { waitUntil: 'networkidle', timeout: 90000 });
    assert.match(await page.title(), /MONAD RUG ARENA/);
    assert.equal(await page.getByText('TESTNET', { exact: true }).count() > 0, true);
    await page.screenshot({ path: `${directory}/arena-${name}-desktop.png`, fullPage: true });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, `${route} desktop horizontal overflow`);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: `${directory}/arena-${name}-mobile.png`, fullPage: true });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, `${route} mobile horizontal overflow`);
    await page.setViewportSize({ width: 1600, height: 1000 });
    checks.push(`${route}: renders at desktop/mobile widths without horizontal overflow`);
  }
  await page.goto(base, { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: '连接 Monad Testnet 钱包', exact: true }).click();
  const walletDialog = page.getByRole('dialog');
  await walletDialog.waitFor();
  assert.match(await walletDialog.innerText(), /MetaMask/);
  assert.equal(await walletDialog.locator('a[href^="https://metamask.app.link/dapp/"]').count(), 1);
  assert.equal(await walletDialog.locator('a[href^="https://link.trustwallet.com/open_url"]').count(), 1);
  assert.equal(await walletDialog.getByText('WalletConnect', { exact: true }).count(), 0, 'An unconfigured connector is not offered');
  assert.equal(await walletDialog.locator('svg').count() > 0, true);
  await page.screenshot({ path: `${directory}/arena-wallet-options.png`, fullPage: true });
  await page.keyboard.press('Escape');
  await walletDialog.waitFor({ state: 'hidden' });
  checks.push('Missing wallet opens actionable app links and a mobile QR, with no unavailable WalletConnect option');
  await page.close();

  // A test-only EIP-1193 connection provider. No key, transaction, or chain receipt is fabricated.
  const wallet = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  wallet.on('pageerror', error => errors.push(error.message));
  await wallet.addInitScript(() => {
    let connected = false;
    let chainId = '0x1';
    const handlers = new Map();
    window.__arenaWalletMethods = [];
    window.ethereum = {
      isMetaMask: true,
      on(name, fn) { if (!handlers.has(name)) handlers.set(name, new Set()); handlers.get(name).add(fn); },
      removeListener(name, fn) { handlers.get(name)?.delete(fn); },
      async request({ method, params }) {
        window.__arenaWalletMethods.push(method);
        if (method === 'eth_requestAccounts') connected = true;
        if (method === 'eth_requestAccounts' || method === 'eth_accounts') return connected ? ['0x2000000000000000000000000000000000000002'] : [];
        if (method === 'eth_chainId') return chainId;
        if (method === 'wallet_switchEthereumChain') {
          if (params[0].chainId !== '0x279f') throw new Error('Unexpected network');
          chainId = params[0].chainId;
          for (const fn of handlers.get('chainChanged') || []) fn(chainId);
          return null;
        }
        if (method === 'wallet_requestPermissions') return [{ parentCapability: 'eth_accounts' }];
        throw new Error(`No wallet write is allowed in this connection-only test: ${method}`);
      },
    };
  });
  await wallet.goto(base, { waitUntil: 'networkidle' });
  await wallet.getByRole('button', { name: '连接 Monad Testnet 钱包', exact: true }).click();
  await wallet.waitForURL('**/play');
  await wallet.getByRole('button', { name: /0x2000/ }).first().waitFor();
  assert.equal(await wallet.getByRole('button', { name: '切换 Monad Testnet', exact: true }).count(), 0);
  const methods = await wallet.evaluate(() => window.__arenaWalletMethods);
  assert(methods.includes('wallet_switchEthereumChain'));
  assert(!methods.some(method => /sendTransaction|signTypedData|personal_sign/.test(method)));
  checks.push('One detected wallet connects, automatically switches only to Monad Testnet and opens /play; no payment is requested by connection');
  await wallet.screenshot({ path: `${directory}/arena-wallet-connected.png`, fullPage: true });
  await wallet.close();
  assert.deepEqual(errors, [], 'Browser runtime errors');
  writeFileSync(`${directory}/arena-browser.json`, JSON.stringify({ verifiedAt: new Date().toISOString(), base, checks, errors, note: 'Connection provider is a browser-test fixture. Contract receipts are separately verified by test:e2e.' }, null, 2));
  console.log(`Browser verification passed: ${checks.length} checks, no runtime errors.`);
} finally { await browser.close(); }
