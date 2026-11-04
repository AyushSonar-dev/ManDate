import { createApp } from './app.js';
import { loadEnv } from './config/env.js';

const env = loadEnv();
const app = createApp();

const server = app.listen(env.PORT, () => {
  console.log(`Mandate Guard API listening on port ${env.PORT} (${env.NODE_ENV})`);
});

function shutdown(signal: string): void {
  console.log(`Received ${signal}, shutting down`);
  server.close(() => process.exit(0));
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
