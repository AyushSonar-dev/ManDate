import type { GuardContextResolver } from '../guard/tool-wrapper.js';
import type { StorefrontProvider } from '../storefront/types.js';

const UNRESOLVED_MERCHANT = '__unresolved_catalog_item__';
const UNRESOLVED_CATEGORY = '__unresolved_catalog_item__';

function orderItemNames(args: Record<string, unknown>): string[] {
  const items = Array.isArray(args.items) ? args.items : [];

  return items.flatMap((entry) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      return [];
    }

    const name = (entry as Record<string, unknown>).name;
    return typeof name === 'string' && name.trim().length > 0
      ? [name.trim()]
      : [];
  });
}

export function createStorefrontOrderContextResolver(
  provider: StorefrontProvider,
  mandateId: string,
): GuardContextResolver {
  return async (args) => {
    const names = orderItemNames(args);

    if (names.length === 0) {
      return {
        mandateId,
        merchant: UNRESOLVED_MERCHANT,
        category: UNRESOLVED_CATEGORY,
      };
    }

    const items = await Promise.all(
      names.map((name) => provider.findByTitle(name)),
    );

    if (items.some((item) => item === null)) {
      return {
        mandateId,
        merchant: UNRESOLVED_MERCHANT,
        category: UNRESOLVED_CATEGORY,
      };
    }

    const resolved = items as NonNullable<(typeof items)[number]>[];
    const merchants = new Set(resolved.map((item) => item.merchantId));
    const categories = new Set(resolved.map((item) => item.category));

    if (merchants.size !== 1 || categories.size !== 1) {
      return {
        mandateId,
        merchant: UNRESOLVED_MERCHANT,
        category: UNRESOLVED_CATEGORY,
      };
    }

    return {
      mandateId,
      merchant: resolved[0]?.merchantId ?? UNRESOLVED_MERCHANT,
      category: resolved[0]?.category ?? UNRESOLVED_CATEGORY,
    };
  };
}
