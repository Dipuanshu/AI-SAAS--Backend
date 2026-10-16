import { z } from 'zod';

export const pageSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export const pageMeta = (page: number, limit: number, total: number) => ({
  page,
  limit,
  total,
  totalPages: Math.max(1, Math.ceil(total / limit)),
});

/** Escapes LIKE wildcards in user-supplied search text. */
export const likePattern = (s: string) => `%${s.toLowerCase().replace(/[%_\\]/g, '\\$&')}%`;
