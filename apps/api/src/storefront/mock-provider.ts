import { CATALOG, merchantName } from './catalog.js';
import type {
  StorefrontItem,
  StorefrontProvider,
  StorefrontSearchOptions,
} from './types.js';

const STOP_WORDS = new Set([
  'a',
  'an',
  'and',
  'any',
  'buy',
  'dollar',
  'dollars',
  'for',
  'from',
  'me',
  'my',
  'of',
  'or',
  'please',
  'the',
  'to',
  'under',
  'with',
]);

const DEFAULT_LIMIT = 12;
const MAX_LIMIT = 12;

function normalize(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ');
}

function tokens(value: string): string[] {
  return [...new Set(value.toLowerCase().match(/[a-z0-9]+/g) ?? [])].filter(
    (token) => token.length > 1 && !STOP_WORDS.has(token),
  );
}

function priceConstraintFromQuery(query: string): number | undefined {
  const match = query.match(
    /(?:under|below|less than|max(?:imum)?(?: of)?)\s*\$?(\d+(?:\.\d{1,2})?)/i,
  );

  if (!match?.[1]) {
    return undefined;
  }

  return Math.round(Number(match[1]) * 100);
}

function matchesPrice(
  item: StorefrontItem,
  maxPriceMinorUnits: number | undefined,
): boolean {
  return (
    maxPriceMinorUnits === undefined ||
    item.priceMinorUnits <= maxPriceMinorUnits
  );
}

function searchableText(item: StorefrontItem): string {
  return normalize(
    [
      item.title,
      item.description,
      item.category,
      item.merchantId,
      item.merchantName,
      ...item.reviews,
    ].join(' '),
  );
}

export class MockStorefrontProvider implements StorefrontProvider {
  private readonly items: StorefrontItem[];

  constructor(items?: StorefrontItem[]) {
    this.items =
      items ??
      CATALOG.items.map((item) => ({
        ...item,
        merchantName: merchantName(item.merchantId),
        reviews: [...item.reviews],
      }));
  }

  async search(
    query: string,
    options: StorefrontSearchOptions = {},
  ): Promise<StorefrontItem[]> {
    const queryTokens = tokens(query);
    const maxPriceMinorUnits =
      options.maxPriceMinorUnits ?? priceConstraintFromQuery(query);
    const requestedLimit = options.limit ?? DEFAULT_LIMIT;
    const limit = Math.max(1, Math.min(requestedLimit, MAX_LIMIT));

    const scored = this.items
      .filter((item) => item.inStock && matchesPrice(item, maxPriceMinorUnits))
      .map((item) => {
        const text = searchableText(item);
        const score = queryTokens.reduce(
          (total, token) => total + (text.includes(token) ? 1 : 0),
          0,
        );

        return { item, score };
      })
      .filter(({ score }) => queryTokens.length === 0 || score > 0)
      .sort(
        (left, right) =>
          right.score - left.score ||
          left.item.priceMinorUnits - right.item.priceMinorUnits ||
          left.item.id.localeCompare(right.item.id),
      )
      .slice(0, limit);

    return scored.map(({ item }) => ({
      ...item,
      reviews: [...item.reviews],
    }));
  }

  async getItem(id: string): Promise<StorefrontItem | null> {
    const item = this.items.find((candidate) => candidate.id === id);

    return item
      ? {
          ...item,
          reviews: [...item.reviews],
        }
      : null;
  }

  async findByTitle(title: string): Promise<StorefrontItem | null> {
    const normalizedTitle = normalize(title);
    const item = this.items.find(
      (candidate) => normalize(candidate.title) === normalizedTitle,
    );

    return item
      ? {
          ...item,
          reviews: [...item.reviews],
        }
      : null;
  }
}
