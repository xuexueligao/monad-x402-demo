import dotenv from 'dotenv';
import { createApp } from './app';

dotenv.config({ path: '.env.arena.local', override: false, quiet: true });
dotenv.config({ path: '.env', override: false, quiet: true });

const arena = await createApp({ logger: true });
await arena.start();
process.once('SIGINT', () => { void arena.close().then(() => process.exit(0)); });
process.once('SIGTERM', () => { void arena.close().then(() => process.exit(0)); });
