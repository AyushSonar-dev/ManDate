import { createApp } from './app.js';
import { loadServerEnv } from './config/env.js';
import { createToolkitPaypalOrders } from './paypal/orders.js';

const env = loadServerEnv();
const paypalOrders = createToolkitPaypalOrders({
  clientId: env.PAYPAL_CLIENT_ID,
  clientSecret: env.PAYPAL_CLIENT_SECRET,
  appBaseUrl: env.APP_BASE_URL,
});
const app = createApp({
  paypalOrders,
  appBaseUrl: env.APP_BASE_URL,
});

const server = app.listen(env.PORT, () => {
  console.log(`Mandate Guard API listening on port ${env.PORT} (${env.NODE_ENV})`);
});

function shutdown(signal: string): void {
  console.log(`Received ${signal}, shutting down`);
  server.close(() => process.exit(0));
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
