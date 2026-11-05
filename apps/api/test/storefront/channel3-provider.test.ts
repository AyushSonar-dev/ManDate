import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Channel3StorefrontProvider } from '../../src/storefront/channel3-provider.js';

const searchResponse = {
  products: [
    {
      id: 'prod-1',
      title: 'Aurora Wireless Headphones',
      description: 'Wireless headphones.',
      category: { slug: 'electronics', title: 'Electronics' },
      offers: [
        {
          domain: 'soundhouse.com',
          price: { price: 39.99, currency: 'USD' },
          availability: 'InStock',
        },
        {
          domain: 'other.example',
          price: { price: 44.5, currency: 'USD' },
          availability: 'InStock',
        },
      ],
      key_features: ['Noise cancellation'],
    },
  ],
  next_page_token: null,
};

const productResponse = searchResponse.products[0];

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), 'mandate-channel3-'));
  temporaryDirectories.push(directory);
  return directory;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function provider(
  cacheDir: string,
  fetchImpl: typeof fetch,
  offline = false,
): Channel3StorefrontProvider {
  return new Channel3StorefrontProvider({
    apiKey: 'test-key',
    cacheDir,
    offline,
    fetch: fetchImpl,
  });
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe('Channel3StorefrontProvider', () => {
  it('maps retailer domains to merchant ids and caches search responses', async () => {
    const cacheDir = await temporaryDirectory();
    const fetchMock = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        jsonResponse(searchResponse),
    );
    const online = provider(cacheDir, fetchMock as unknown as typeof fetch);

    const results = await online.search('wireless headphones', {
      maxPriceMinorUnits: 4_000,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.trychannel3.com/v1/search',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ 'x-api-key': 'test-key' }),
      }),
    );
    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({
      merchantId: 'soundhouse',
      merchantName: 'SoundHouse',
      category: 'electronics',
      title: 'Aurora Wireless Headphones',
      priceMinorUnits: 3_999,
      currency: 'USD',
    });
    expect(results[1]).toMatchObject({
      merchantId: 'other.example',
      merchantName: 'other.example',
      priceMinorUnits: 4_450,
    });

    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(String(request.body))).toMatchObject({
      query: 'wireless headphones',
      filters: { price: { max_price: 40 } },
    });
    expect(await readdir(cacheDir)).toHaveLength(1);
  });

  it('accepts the documented amount-shaped offer price', async () => {
    const cacheDir = await temporaryDirectory();
    const amountResponse = {
      products: [
        {
          ...searchResponse.products[0],
          offers: [
            {
              domain: 'soundhouse.com',
              price: { amount: 39.99, currency: 'USD' },
              availability: 'InStock',
            },
          ],
        },
      ],
      next_page_token: null,
    };
    const fetchMock = vi.fn(async () => jsonResponse(amountResponse));
    const online = provider(cacheDir, fetchMock as unknown as typeof fetch);

    const results = await online.search('wireless headphones');

    expect(results[0]).toMatchObject({
      merchantId: 'soundhouse',
      priceMinorUnits: 3_999,
      currency: 'USD',
    });
  });

  it('replays cached search results offline without calling the network', async () => {
    const cacheDir = await temporaryDirectory();
    const onlineFetch = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        jsonResponse(searchResponse),
    );
    const online = provider(cacheDir, onlineFetch as unknown as typeof fetch);
    const onlineResults = await online.search('wireless headphones');

    const offlineFetch = vi.fn(async () => {
      throw new Error('network must not be used offline');
    });
    const offline = provider(
      cacheDir,
      offlineFetch as unknown as typeof fetch,
      true,
    );
    const offlineResults = await offline.search('wireless headphones');

    expect(offlineResults).toEqual(onlineResults);
    expect(offlineFetch).not.toHaveBeenCalled();
  });

  it('loads and caches full item details, including offline replay', async () => {
    const cacheDir = await temporaryDirectory();
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      return url.includes('/v1/products/')
        ? jsonResponse(productResponse)
        : jsonResponse(searchResponse);
    });
    const online = provider(cacheDir, fetchMock as unknown as typeof fetch);
    const [first] = await online.search('wireless headphones');

    expect(first).toBeDefined();
    const detail = await online.getItem(first?.id ?? '');

    expect(detail).toMatchObject({
      title: 'Aurora Wireless Headphones',
      description: 'Wireless headphones.',
      reviews: ['Noise cancellation'],
      priceMinorUnits: 3_999,
    });

    const offlineFetch = vi.fn(async () => {
      throw new Error('network must not be used offline');
    });
    const offline = provider(
      cacheDir,
      offlineFetch as unknown as typeof fetch,
      true,
    );

    await expect(offline.getItem(first?.id ?? '')).resolves.toEqual(detail);
    expect(offlineFetch).not.toHaveBeenCalled();
  });

  it('replays cached results offline without an API key', async () => {
    const cacheDir = await temporaryDirectory();
    const onlineFetch = vi.fn(async () => jsonResponse(searchResponse));
    const online = provider(cacheDir, onlineFetch as unknown as typeof fetch);
    await online.search('wireless headphones');

    const offlineFetch = vi.fn(async () => {
      throw new Error('network must not be used offline');
    });
    const offline = new Channel3StorefrontProvider({
      apiKey: '',
      cacheDir,
      offline: true,
      fetch: offlineFetch as unknown as typeof fetch,
    });

    await expect(offline.search('wireless headphones')).resolves.toHaveLength(2);
    expect(offlineFetch).not.toHaveBeenCalled();
  });

  it('fails closed on an offline cache miss without network access', async () => {
    const cacheDir = await temporaryDirectory();
    const fetchMock = vi.fn(async () => jsonResponse(searchResponse));
    const offline = provider(
      cacheDir,
      fetchMock as unknown as typeof fetch,
      true,
    );

    await expect(offline.search('wireless headphones')).rejects.toThrow(
      /offline cache miss/,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
