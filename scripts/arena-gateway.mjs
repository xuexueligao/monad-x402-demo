import http from 'node:http';
import net from 'node:net';
import { pathToFileURL } from 'node:url';

const backendPath = (url = '/') => /^\/(?:api\/(?:game|challenges|transactions)(?:\/|\?|$)|api\/health(?:\?|$)|health(?:\?|$)|socket\.io(?:\/|\?|$))/.test(url);

export function startGateway({ port = Number(process.env.ARENA_GATEWAY_PORT || process.env.PORT || 4100), host = '0.0.0.0', frontendPort = 3150, backendPort = Number(process.env.ARENA_BACKEND_PORT || 4000) } = {}) {
  const connections = new Set();
  const track = (socket) => {
    if (!connections.has(socket)) { connections.add(socket); socket.once('close', () => connections.delete(socket)); }
    return socket;
  };
  const targetPort = (url) => backendPath(url) ? backendPort : frontendPort;
  const server = http.createServer((request, response) => {
    const upstream = http.request({
      hostname: '127.0.0.1', port: targetPort(request.url), path: request.url, method: request.method,
      headers: {
        ...request.headers,
        'x-forwarded-host': request.headers['x-forwarded-host'] || request.headers.host || '',
        'x-forwarded-proto': request.headers['x-forwarded-proto'] || 'http',
      },
    }, (result) => {
      response.writeHead(result.statusCode || 502, result.headers);
      result.pipe(response);
      result.on('error', () => response.destroy());
    });
    upstream.on('socket', track);
    upstream.on('error', () => {
      if (response.headersSent) response.destroy();
      else { response.writeHead(502, { 'content-type': 'application/json', 'cache-control': 'no-store' }); response.end(JSON.stringify({ error: 'Arena service is starting. Please retry shortly.' })); }
    });
    request.on('aborted', () => upstream.destroy());
    response.on('close', () => { if (!response.writableFinished) upstream.destroy(); });
    request.pipe(upstream);
  });
  server.requestTimeout = 0;
  server.on('connection', track);
  server.on('upgrade', (request, socket, head) => {
    const upstream = track(net.connect(targetPort(request.url), '127.0.0.1'));
    upstream.once('connect', () => {
      // Forward the original upgrade handshake, then proxy the actual WebSocket bytes.
      const headers = [...request.rawHeaders];
      if (!request.headers['x-forwarded-host']) headers.push('X-Forwarded-Host', request.headers.host || '');
      if (!request.headers['x-forwarded-proto']) headers.push('X-Forwarded-Proto', 'http');
      let handshake = `${request.method} ${request.url} HTTP/${request.httpVersion}\r\n`;
      for (let index = 0; index < headers.length; index += 2) handshake += `${headers[index]}: ${headers[index + 1]}\r\n`;
      upstream.write(`${handshake}\r\n`);
      if (head.length) upstream.write(head);
      socket.pipe(upstream).pipe(socket);
    });
    upstream.on('error', () => {
      if (!socket.destroyed) socket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n');
    });
    socket.on('error', () => upstream.destroy());
    socket.once('close', () => upstream.destroy());
    upstream.once('close', () => socket.destroy());
  });
  const ready = new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => { server.removeListener('error', reject); resolve(server.address()); });
  });
  async function close() {
    const done = new Promise((resolve) => server.close(resolve));
    for (const socket of connections) socket.destroy();
    await done;
  }
  return { server, ready, close };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const gateway = startGateway();
  const address = await gateway.ready;
  console.log(`MONAD RUG ARENA gateway listening on port ${address.port}`);
  let stopping = false;
  const stop = async () => { if (stopping) return; stopping = true; await gateway.close(); process.exitCode = 0; };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}
