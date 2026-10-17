import { isAddress, type Address, type Hex } from 'viem';
import { TESTNET } from '../shared/config';

export interface ServerConfig {
  host: string;
  port: number;
  rpcUrl: string;
  chainId: number;
  contractAddress?: Address;
  signerKey?: Hex;
  origins: string[];
  joinUrl: string;
  deploymentBlock?: bigint;
  pollIntervalMs: number;
  aiApiKey?: string;
  aiBaseUrl: string;
  aiModel: string;
  sessionStorePath?: string;
}

export function readConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const rpcUrl = env.ARENA_RPC_URL || env.MONAD_RPC_URL || TESTNET.rpc;
  const chainId = Number(env.ARENA_CHAIN_ID || TESTNET.chainId);
  const isLoopback = ['localhost', '127.0.0.1', '[::1]'].includes(new URL(rpcUrl).hostname);
  if (chainId !== TESTNET.chainId && !(chainId === 31337 && isLoopback)) {
    throw new Error('Only Monad Testnet is supported; chain 31337 is allowed on a local test RPC.');
  }
  const address = env.ARENA_CONTRACT_ADDRESS || env.NEXT_PUBLIC_ARENA_CONTRACT_ADDRESS;
  if (address && !isAddress(address)) throw new Error('ARENA_CONTRACT_ADDRESS is invalid.');
  const signerKey = env.ARENA_RESULT_SIGNER_PRIVATE_KEY;
  if (signerKey && !/^0x[\da-f]{64}$/i.test(signerKey)) {
    throw new Error('ARENA_RESULT_SIGNER_PRIVATE_KEY must be a 32-byte private key.');
  }
  return {
    host: env.API_HOST || '0.0.0.0',
    port: Number(env.API_PORT || 4000),
    rpcUrl,
    chainId,
    contractAddress: address as Address | undefined,
    signerKey: signerKey as Hex | undefined,
    origins: (env.ARENA_ALLOWED_ORIGINS || env.FRONTEND_URL || 'http://localhost:3150,http://127.0.0.1:3150').split(',').map((v) => v.trim()).filter(Boolean),
    joinUrl: env.PUBLIC_JOIN_URL || env.NEXT_PUBLIC_JOIN_URL || env.FRONTEND_URL || 'http://localhost:3150',
    deploymentBlock: env.ARENA_DEPLOYMENT_BLOCK ? BigInt(env.ARENA_DEPLOYMENT_BLOCK) : undefined,
    pollIntervalMs: Number(env.ARENA_POLL_INTERVAL_MS || 2000),
    aiApiKey: env.AI_API_KEY || env.OPENAI_API_KEY,
    aiBaseUrl: (env.AI_BASE_URL || env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, ''),
    aiModel: env.AI_MODEL || env.OPENAI_MODEL || 'gpt-4o-mini',
    // Test fixtures pass an explicit environment and stay entirely in memory.
    sessionStorePath: env.ARENA_SESSION_STORE_PATH || (env === process.env ? '.local/arena-sessions.json' : undefined),
  };
}
