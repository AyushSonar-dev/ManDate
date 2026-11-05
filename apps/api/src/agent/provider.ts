import path from 'node:path';
import type { AgentEnv } from '../config/env.js';
import { Channel3StorefrontProvider } from '../storefront/channel3-provider.js';
import { MockStorefrontProvider } from '../storefront/mock-provider.js';
import type { StorefrontProvider } from '../storefront/types.js';

export function createStorefrontProvider(env: AgentEnv): StorefrontProvider {
  if (env.STOREFRONT_PROVIDER === 'mock') {
    return new MockStorefrontProvider();
  }

  if (!env.CHANNEL3_OFFLINE && !env.CHANNEL3_API_KEY) {
    throw new Error(
      'CHANNEL3_API_KEY is required when STOREFRONT_PROVIDER=channel3',
    );
  }

  return new Channel3StorefrontProvider({
    apiKey: env.CHANNEL3_API_KEY ?? '',
    baseUrl: env.CHANNEL3_BASE_URL,
    cacheDir: path.resolve(process.cwd(), env.CHANNEL3_CACHE_DIR),
    offline: env.CHANNEL3_OFFLINE,
  });
}
