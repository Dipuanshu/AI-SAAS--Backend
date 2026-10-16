import { query } from '../db/pool';

export function slugify(input: string): string {
  const s = input
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return s || 'company';
}

export async function uniqueCompanySlug(name: string): Promise<string> {
  const base = slugify(name);
  let candidate = base;
  for (let i = 2; i < 1000; i++) {
    const { rowCount } = await query('SELECT 1 FROM companies WHERE slug = $1', [candidate]);
    if (!rowCount) return candidate;
    candidate = `${base}-${i}`;
  }
  return `${base}-${Date.now()}`;
}
