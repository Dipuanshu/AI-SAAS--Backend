import { z, ZodType } from 'zod';
import { badRequest } from '../utils/httpError';

export function parse<T extends ZodType>(schema: T, data: unknown): z.infer<T> {
  const result = schema.safeParse(data);
  if (!result.success) {
    const details = result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
    throw badRequest(details[0] ? `${details[0].path || 'input'}: ${details[0].message}` : 'Invalid input', 'VALIDATION_ERROR', details);
  }
  return result.data;
}
