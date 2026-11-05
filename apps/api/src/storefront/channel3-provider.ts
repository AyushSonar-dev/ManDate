import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { catalogRetailerMap, merchantName } from './catalog.js';
import type {
  StorefrontItem,
  StorefrontProvider,
  StorefrontSearchOptions,
} from './types.js';

const DEFAULT_BASE_URL = 'https://api.trychannel3.com';
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 30;
const ITEM_ID_PREFIX = 'c3_';

interface CachedResponse {
  status: number;
  body: unknown;
  url: string;
  cachedAt: string;
}

const priceSchema = z
  .object({
    price: z.number().finite().nonnegative().optional(),
    amount: z.number().finite().nonnegative().optional(),
    currency: z.string().min(3),
  })
  .refine((value) => value.price !== undefined || value.amount !== undefined, {
    message: 'offer price must contain either price or amount',
  });

const offerSchema = z.object({
  domain: z.string().min(1),
  price: priceSchema,
  availability: z.string().optional(),
});

const categorySchema = z.object({
  slug: z.string().min(1),
  title: z.string().optional(),
});

const productSchema = z.object({
  id: z.string().min(1),
  title: z.string(),
  description: z.string().nullish(),
  category: categorySchema.nullish(),
  offers: z.array(offerSchema).optional(),
  key_features: z.array(z.string()).nullish(),
});

const searchResponseSchema = z.object({
  products: z.array(productSchema),
  next_page_token: z.string().nullish(),
});

type Channel3Price = z.infer<typeof priceSchema>;
type Channel3Offer = z.infer<typeof offerSchema>;
type Channel3Product = z.infer<typeof productSchema>;

interface Channel3ItemId {
  productId: string;
  domain: string;
}

export interface Channel3StorefrontOptions {
  apiKey: string;
  cacheDir: string;
  baseUrl?: string;
  offline?: boolean;
  retailerMap?: Record<string, string>;
  fetch?: typeof fetch;
}

export class DiskResponseCache {
  constructor(private readonly directory: string) {}

  private fileFor(key: string): string {
    const digest = createHash('sha256').update(key).digest('hex');
    return path.join(this.directory, `${digest}.json`);
  }

  async get(key: string): Promise<CachedResponse | null> {
    try {
      const content = await readFile(this.fileFor(key), 'utf8');
      return JSON.parse(content) as CachedResponse;
    } catch (error) {
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        (error as { code?: unknown }).code === 'ENOENT'
      ) {
        return null;
      }

      throw error;
    }
  }

  async set(key: string, response: CachedResponse): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    await writeFile(
      this.fileFor(key),
      `${JSON.stringify(response, null, 2)}\n`,
      'utf8',
    );
  }
}

function normalizeTitle(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ');
}

function encodeItemId(input: Channel3ItemId): string {
  return `${ITEM_ID_PREFIX}${Buffer.from(JSON.stringify(input)).toString('base64url')}`;
}

function decodeItemId(id: string): Channel3ItemId | null {
  if (!id.startsWith(ITEM_ID_PREFIX)) {
    return null;
  }

  try {
    const parsed = JSON.parse(
      Buffer.from(id.slice(ITEM_ID_PREFIX.length), 'base64url').toString('utf8'),
    ) as Partial<Channel3ItemId>;

    return typeof parsed.productId === 'string' &&
      parsed.productId.length > 0 &&
      typeof parsed.domain === 'string' &&
      parsed.domain.length > 0
      ? { productId: parsed.productId, domain: parsed.domain }
      : null;
  } catch {
    return null;
  }
}

function toMinorUnits(price: Channel3Price): number | null {
  const amount = price.price ?? price.amount;

  if (typeof amount !== 'number' || !Number.isFinite(amount)) {
    return null;
  }

  const minorUnits = Math.round(amount * 100);
  return Number.isSafeInteger(minorUnits) && minorUnits >= 0 ? minorUnits : null;
}

export class Channel3StorefrontProvider implements StorefrontProvider {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly offline: boolean;
  private readonly retailerMap: Record<string, string>;
  private readonly fetchImpl: typeof fetch;
  private readonly cache: DiskResponseCache;

  constructor(options: Channel3StorefrontOptions) {
    this.offline = options.offline ?? false;

    if (!this.offline && options.apiKey.trim().length === 0) {
      throw new Error('CHANNEL3_API_KEY is required for the Channel3 provider');
    }

    this.apiKey = options.apiKey.trim();
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.retailerMap = {
      ...catalogRetailerMap(),
      ...Object.fromEntries(
        Object.entries(options.retailerMap ?? {}).map(([domain, merchantId]) => [
          domain.toLowerCase(),
          merchantId,
        ]),
      ),
    };
    this.fetchImpl = options.fetch ?? fetch;
    this.cache = new DiskResponseCache(options.cacheDir);
  }

  private merchantFor(domain: string): { id: string; name: string } {
    const normalizedDomain = domain.toLowerCase();
    const mappedId = this.retailerMap[normalizedDomain];

    return mappedId
      ? { id: mappedId, name: merchantName(mappedId) }
      : { id: normalizedDomain, name: normalizedDomain };
  }

  private mapOffer(
    product: Channel3Product,
    offer: Channel3Offer,
  ): StorefrontItem | null {
    if (typeof offer.domain !== 'string' || offer.domain.length === 0) {
      return null;
    }

    const priceMinorUnits = toMinorUnits(offer.price);

    if (priceMinorUnits === null) {
      return null;
    }

    const merchant = this.merchantFor(offer.domain);

    return {
      id: encodeItemId({ productId: product.id, domain: offer.domain }),
      merchantId: merchant.id,
      merchantName: merchant.name,
      category: product.category?.slug ?? 'uncategorized',
      title: product.title,
      description: product.description ?? '',
      priceMinorUnits,
      currency: offer.price.currency,
      inStock: offer.availability === undefined || offer.availability === 'InStock',
      reviews: [...(product.key_features ?? [])],
    };
  }

  private productsToItems(products: Channel3Product[]): StorefrontItem[] {
    return products.flatMap((product) =>
      (product.offers ?? []).flatMap((offer) => {
        const item = this.mapOffer(product, offer);
        return item === null ? [] : [item];
      }),
    );
  }

  private async requestJson(
    pathname: string,
    init: { method: 'GET' | 'POST'; body?: unknown },
  ): Promise<unknown> {
    const url = `${this.baseUrl}${pathname}`;
    const key = JSON.stringify({
      method: init.method,
      url,
      body: init.body ?? null,
    });
    const cached = await this.cache.get(key);

    if (this.offline) {
      if (!cached) {
        throw new Error(`Channel3 offline cache miss for ${init.method} ${url}`);
      }

      if (cached.status < 200 || cached.status >= 300) {
        throw new Error(`Cached Channel3 response failed with ${cached.status}`);
      }

      return cached.body;
    }

    let response: Response;

    try {
      response = await this.fetchImpl(url, {
        method: init.method,
        headers: {
          'content-type': 'application/json',
          'x-api-key': this.apiKey,
        },
        ...(init.body === undefined
          ? {}
          : { body: JSON.stringify(init.body) }),
      });
    } catch (error) {
      if (cached && cached.status >= 200 && cached.status < 300) {
        return cached.body;
      }

      throw error;
    }

    const text = await response.text();
    const body = text.length === 0 ? null : (JSON.parse(text) as unknown);

    await this.cache.set(key, {
      status: response.status,
      body,
      url,
      cachedAt: new Date().toISOString(),
    });

    if (!response.ok) {
      throw new Error(`Channel3 request failed with ${response.status}`);
    }

    return body;
  }

  async search(
    query: string,
    options: StorefrontSearchOptions = {},
  ): Promise<StorefrontItem[]> {
    const requestedLimit = options.limit ?? DEFAULT_LIMIT;
    const limit = Math.max(1, Math.min(requestedLimit, MAX_LIMIT));
    const body = await this.requestJson('/v1/search', {
      method: 'POST',
      body: {
        query,
        limit,
        ...(options.maxPriceMinorUnits === undefined
          ? {}
          : {
              filters: {
                price: { max_price: options.maxPriceMinorUnits / 100 },
              },
            }),
        config: { country: 'US', currency: 'USD' },
      },
    });

    const response = searchResponseSchema.parse(body);

    return this.productsToItems(response.products)
      .filter((item) => item.inStock)
      .sort(
        (left, right) =>
          left.priceMinorUnits - right.priceMinorUnits ||
          left.id.localeCompare(right.id),
      )
      .slice(0, limit);
  }

  async getItem(id: string): Promise<StorefrontItem | null> {
    const parsed = decodeItemId(id);

    if (!parsed) {
      return null;
    }

    const body = await this.requestJson(
      `/v1/products/${encodeURIComponent(parsed.productId)}?country=US&currency=USD`,
      { method: 'GET' },
    );
    const product = productSchema.parse(body);
    const offer = (product.offers ?? []).find(
      (candidate) =>
        candidate.domain.toLowerCase() === parsed.domain.toLowerCase(),
    );

    return offer ? this.mapOffer(product, offer) : null;
  }

  async findByTitle(title: string): Promise<StorefrontItem | null> {
    const normalizedTitle = normalizeTitle(title);
    const matches = await this.search(title, { limit: MAX_LIMIT });

    return (
      matches.find(
        (item) => normalizeTitle(item.title) === normalizedTitle,
      ) ?? null
    );
  }
}
