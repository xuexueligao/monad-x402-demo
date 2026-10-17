import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { decodeFunctionData, encodeFunctionResult } from 'viem';
import { createChainAdapter } from '../server/chain.ts';
import { readConfig } from '../server/config.ts';

const artifact = JSON.parse(readFileSync(new URL('../contracts/abi/RugArena.json', import.meta.url), 'utf8'));
const abi = Array.isArray(artifact) ? artifact : artifact.abi;
const contract = '0x1000000000000000000000000000000000000001';
const zero = '0x0000000000000000000000000000000000000000';

async function fixture(t) {
  const ranges = [];
  const state = { failFrom: undefined };
  const values = {
    getCurrentRound: { id: 1n, prizePool: 0n, challengeFee: 10n ** 19n, endsAt: 9999999999n, active: true, winner: zero, reward: 0n, rewardClaimed: false },
    getPlayers: [], totalChallenges: 0n, resultSigner: contract,
  };
  const rpc = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const { id, method, params } = JSON.parse(Buffer.concat(chunks).toString());
    let result;
    if (method === 'eth_chainId') result = '0x7a69';
    else if (method === 'eth_getCode') result = '0x6000';
    else if (method === 'eth_blockNumber') result = '0xcd'; // 205
    else if (method === 'eth_call') {
      const { functionName } = decodeFunctionData({ abi, data: params[0].data });
      result = encodeFunctionResult({ abi, functionName, result: values[functionName] });
    } else if (method === 'eth_getLogs') {
      const from = BigInt(params[0].fromBlock), to = BigInt(params[0].toBlock);
      ranges.push([from, to]);
      if (to - from + 1n > 100n || from === state.failFrom) {
        response.writeHead(503, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32603, message: 'RPC log range temporarily unavailable' } }));
        return;
      }
      result = [];
    } else {
      response.writeHead(400);
      response.end();
      return;
    }
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ jsonrpc: '2.0', id, result }));
  });
  await new Promise(resolve => rpc.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { rpc.close(resolve); rpc.closeAllConnections(); }));
  const adapter = createChainAdapter(readConfig({ ARENA_CHAIN_ID: '31337', ARENA_RPC_URL: `http://127.0.0.1:${rpc.address().port}`, ARENA_CONTRACT_ADDRESS: contract, ARENA_DEPLOYMENT_BLOCK: '1' }));
  return { adapter, ranges, state };
}

test('public RPC log batches contain at most 100 inclusive blocks and consecutive refreshes do not replay history', async (t) => {
  const { adapter, ranges } = await fixture(t);
  await adapter.refresh();
  assert.deepEqual(ranges, [[1n, 100n], [101n, 200n], [201n, 205n]]);
  assert.equal(adapter.world().round.id, '1');
  await adapter.refresh();
  assert.equal(ranges.length, 3);
});

test('a failed batch preserves the cursor and retries only the incomplete history', async (t) => {
  const { adapter, ranges, state } = await fixture(t);
  state.failFrom = 101n;
  await assert.rejects(adapter.refresh());
  assert.deepEqual(ranges[0], [1n, 100n]);
  assert(ranges.slice(1).every(([from, to]) => from === 101n && to === 200n));
  state.failFrom = undefined;
  const failedRequests = ranges.length;
  await adapter.refresh();
  assert.deepEqual(ranges.slice(failedRequests), [[101n, 200n], [201n, 205n]]);
  assert.equal(ranges.filter(([from]) => from === 1n).length, 1);
});
