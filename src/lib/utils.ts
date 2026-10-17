import { formatEther } from 'viem';

export function shortAddress(value?: string | null) {
  return value ? `${value.slice(0, 6)}…${value.slice(-4)}` : '等待玩家';
}
export function mon(wei?: string | bigint | null, decimals = 3) {
  const raw = formatEther(BigInt(wei || '0'));
  const [whole, fraction = ''] = raw.split('.');
  if (decimals === 0) return whole;
  return `${whole}.${fraction.padEnd(decimals, '0').slice(0, decimals)}`;
}
export function ago(timestamp: number) {
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  return seconds < 60 ? `${seconds} 秒前` : `${Math.floor(seconds / 60)} 分钟前`;
}
