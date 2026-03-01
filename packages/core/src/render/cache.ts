export interface ISRCacheEntry {
  generatedAt: number;
  html: string;
  revalidate: number;
}

export const isrCache = new Map<string, ISRCacheEntry>();

export const ssgCache = new Map<string, string>();
