export const API_URL = process.env.NEXT_PUBLIC_API_URL || (typeof window !== 'undefined'
  ? window.location.port === '3150'
    ? `${window.location.protocol}//${window.location.hostname}:4000`
    : window.location.origin
  : 'http://localhost:4000');

export class ApiError extends Error {
  constructor(message: string, readonly status: number) { super(message); this.name = 'ApiError'; }
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...init.headers },
    cache: 'no-store',
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new ApiError(data.message || data.error || `请求失败 (${response.status})`, response.status);
  return data as T;
}
