import { jsonSchema, tool, type ToolSet } from 'ai';
import type { StorefrontItem, StorefrontProvider } from './types.js';

interface SearchCatalogArgs {
  query: string;
  limit?: number;
  maxPriceMinorUnits?: number;
}

interface GetItemArgs {
  itemId: string;
}

function searchResult(item: StorefrontItem) {
  return {
    itemId: item.id,
    title: item.title,
    merchantId: item.merchantId,
    merchantName: item.merchantName,
    category: item.category,
    priceMinorUnits: item.priceMinorUnits,
    currency: item.currency,
    inStock: item.inStock,
  };
}

export function createStorefrontTools(provider: StorefrontProvider): ToolSet {
  return {
    search_catalog: tool({
      description:
        'Search the storefront catalog for products. Returns product summaries with integer minor-unit prices.',
      parameters: jsonSchema<SearchCatalogArgs>({
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Natural-language product search query.',
          },
          limit: {
            type: 'integer',
            minimum: 1,
            maximum: 12,
            description: 'Maximum number of products to return.',
          },
          maxPriceMinorUnits: {
            type: 'integer',
            minimum: 0,
            description: 'Optional maximum unit price in integer minor units.',
          },
        },
        required: ['query'],
        additionalProperties: false,
      }),
      execute: async (args) => {
        const items = await provider.search(args.query, {
          ...(args.limit === undefined ? {} : { limit: args.limit }),
          ...(args.maxPriceMinorUnits === undefined
            ? {}
            : { maxPriceMinorUnits: args.maxPriceMinorUnits }),
        });

        return {
          resultCount: items.length,
          results: items.map(searchResult),
        };
      },
    }),
    get_item: tool({
      description:
        'Get the full product page for a catalog item, including description and reviews.',
      parameters: jsonSchema<GetItemArgs>({
        type: 'object',
        properties: {
          itemId: {
            type: 'string',
            description: 'The itemId returned by search_catalog.',
          },
        },
        required: ['itemId'],
        additionalProperties: false,
      }),
      execute: async (args) => {
        const item = await provider.getItem(args.itemId);

        return item
          ? { found: true, item }
          : { found: false, itemId: args.itemId };
      },
    }),
  };
}
