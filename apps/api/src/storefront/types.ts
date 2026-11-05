export interface StorefrontMerchant {
  id: string;
  name: string;
  domains: string[];
}

export interface StorefrontItem {
  id: string;
  merchantId: string;
  merchantName: string;
  category: string;
  title: string;
  description: string;
  priceMinorUnits: number;
  currency: string;
  inStock: boolean;
  reviews: string[];
}

export interface StorefrontSearchOptions {
  limit?: number;
  maxPriceMinorUnits?: number;
}

export interface StorefrontProvider {
  search(
    query: string,
    options?: StorefrontSearchOptions,
  ): Promise<StorefrontItem[]>;
  getItem(id: string): Promise<StorefrontItem | null>;
  findByTitle(title: string): Promise<StorefrontItem | null>;
}
