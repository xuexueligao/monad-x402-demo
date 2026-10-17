import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import { Server as SocketServer } from 'socket.io';
import { isAddress, type Hex } from 'viem';
import { z, ZodError } from 'zod';
import { createAiService, type AiService } from './ai';
import { createChainAdapter, type ChainAdapter } from './chain';
import { readConfig, type ServerConfig } from './config';
import { ApiError, ArenaGame } from './game';

const addressSchema = z.string().refine((v) => isAddress(v), 'A valid EVM wallet address is required.');
const hashSchema = z.string().regex(/^0x[\da-f]{64}$/i, 'A 32-byte hash is required.');
const tokenSchema = z.string().min(1).max(200);

export interface CreateAppOptions {
  config?: ServerConfig;
  chain?: ChainAdapter;
  ai?: AiService;
  now?: () => number;
  autoPoll?: boolean;
  logger?: boolean;
}
export interface ArenaApplication {
  app: FastifyInstance;
  io: SocketServer;
  game: ArenaGame;
  config: ServerConfig;
  start(): Promise<string>;
  close(): Promise<void>;
}

export async function createApp(options: CreateAppOptions = {}): Promise<ArenaApplication> {
  const config = options.config || readConfig();
  const app = Fastify({ logger: options.logger ?? false, bodyLimit: 16 * 1024 });
  await app.register(cors, { origin: config.origins, methods: ['GET', 'POST'] });
  const io = new SocketServer(app.server, { cors: { origin: config.origins, methods: ['GET', 'POST'] }, maxHttpBufferSize: 16 * 1024 });
  const chain = options.chain || createChainAdapter(config);
  const game = new ArenaGame(config, chain, options.ai || createAiService(config), { now: options.now });
  game.onEvent((event) => { io.emit('game:event', event); io.emit('snapshot', game.snapshot()); });
  game.onPrivateEvent((id, event) => { io.to(`challenge:${id}`).emit('agent:event', event); });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ApiError) return reply.code(error.statusCode).send({ error: error.message });
    if (error instanceof ZodError) return reply.code(400).send({ error: error.issues[0]?.message || 'Invalid request.' });
    if (error instanceof Error && 'statusCode' in error && typeof error.statusCode === 'number' && error.statusCode < 500) {
      return reply.code(error.statusCode).send({ error: error.message });
    }
    request.log.error({ err: error }, 'Arena request failed');
    return reply.code(500).send({ error: 'The arena service could not complete this request. Please retry.' });
  });

  const health = async () => {
    const state = game.snapshot();
    return {
      status: state.chainError ? 'rpc-unavailable' : state.configured && config.signerKey ? 'ready' : 'needs-configuration',
      configured: state.configured, aiMode: state.aiMode, chainId: state.chainId,
      contractAddress: state.contractAddress, signerConfigured: !!config.signerKey,
      agentRuntime: 'pi-agent-core',
      ...(state.chainError ? { chainError: state.chainError } : {}),
    };
  };
  app.get('/health', health);
  app.get('/api/health', health);
  app.get('/api/game/state', async () => game.snapshot());
  app.get('/api/game/leaderboard', async () => game.snapshot().leaderboard);

  app.post('/api/challenges/start', async (request) => {
    const body = z.object({ player: addressSchema }).parse(request.body);
    return game.start(body.player);
  });
  app.post('/api/challenges/:id/message', async (request) => {
    const { id } = z.object({ id: hashSchema }).parse(request.params);
    const { token, message } = z.object({ token: tokenSchema, message: z.string().trim().min(1).max(1200) }).parse(request.body);
    return game.message(id, token, message);
  });
  app.post('/api/challenges/:id/finish', async (request) => {
    const { id } = z.object({ id: hashSchema }).parse(request.params);
    const { token } = z.object({ token: tokenSchema }).parse(request.body);
    return game.finish(id, token);
  });
  app.get('/api/game/challenges/:id', async (request) => {
    const { id } = z.object({ id: hashSchema }).parse(request.params);
    return game.getSession(id, tokenSchema.parse(request.headers['x-challenge-token']));
  });
  app.get('/api/transactions/:hash', async (request, reply) => {
    const { hash } = z.object({ hash: hashSchema }).parse(request.params);
    if (!chain.configured) throw new ApiError(503, 'No arena contract is configured.');
    try { return await chain.getTransaction(hash as Hex); }
    catch { return reply.code(404).send({ error: 'Transaction is not available from the configured RPC yet.' }); }
  });
  app.post('/api/transactions/track', async (request) => {
    const { hash, challengeId } = z.object({ hash: hashSchema, challengeId: hashSchema.optional() }).parse(request.body);
    try { await chain.observeTransaction(hash as Hex, challengeId); }
    catch { throw new ApiError(400, 'Transaction has not appeared on the RPC or is not a valid RugArena action.'); }
    return { tracked: true };
  });

  io.on('connection', (socket) => {
    socket.emit('snapshot', game.snapshot());
    socket.on('challenge:watch', (payload: unknown, ack?: (result: unknown) => void) => {
      const parsed = z.object({ challengeId: hashSchema, token: tokenSchema }).safeParse(payload);
      if (!parsed.success) { ack?.({ error: 'Invalid challenge session.' }); return; }
      try {
        game.getSession(parsed.data.challengeId, parsed.data.token);
        for (const room of socket.rooms) if (room.startsWith('challenge:')) void socket.leave(room);
        void socket.join(`challenge:${parsed.data.challengeId}`);
        ack?.({ watching: true });
      } catch { ack?.({ error: 'Invalid challenge session token.' }); }
    });
    socket.on('player:join', (payload: unknown) => {
      const parsed = z.object({ player: addressSchema }).safeParse(payload);
      if (!parsed.success) return;
      game.join(socket.id, parsed.data.player);
      io.emit('snapshot', game.snapshot());
    });
    socket.on('player:leave', () => { game.leave(socket.id); io.emit('snapshot', game.snapshot()); });
    socket.on('disconnect', () => { game.leave(socket.id); io.emit('snapshot', game.snapshot()); });
    socket.on('chain:submitted', async (payload: unknown, ack?: (result: unknown) => void) => {
      const parsed = z.object({ hash: hashSchema, challengeId: hashSchema.optional() }).safeParse(payload);
      if (!parsed.success) { ack?.({ error: 'Invalid transaction hash.' }); return; }
      try {
        await chain.observeTransaction(parsed.data.hash as Hex, parsed.data.challengeId);
        ack?.({ tracked: true });
      } catch {
        // Invalid client announcements cannot create globally visible chain confirmations or failures.
        ack?.({ error: 'Transaction is not visible on the arena RPC or is not a valid arena action. Retry tracking shortly.' });
      }
    });
  });
  await game.refresh();
  let polling = false;
  const timer = options.autoPoll === false ? undefined : setInterval(async () => {
    if (polling) return;
    polling = true;
    try { await game.refresh(); io.emit('snapshot', game.snapshot()); }
    finally { polling = false; }
  }, config.pollIntervalMs);
  timer?.unref();
  app.addHook('onClose', async () => { if (timer) clearInterval(timer); io.disconnectSockets(true); });
  return {
    app, io, game, config,
    start: () => app.listen({ host: config.host, port: config.port }),
    async close() { io.disconnectSockets(true); await app.close(); io.close(); },
  };
}
