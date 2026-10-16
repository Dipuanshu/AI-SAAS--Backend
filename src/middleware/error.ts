import { NextFunction, Request, Response } from 'express';
import { env } from '../config/env';
import { HttpError } from '../utils/httpError';

export function notFoundHandler(req: Request, res: Response) {
  res.status(404).json({ error: { code: 'NOT_FOUND', message: `Route ${req.method} ${req.path} not found` } });
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function errorHandler(err: any, _req: Request, res: Response, _next: NextFunction) {
  if (err instanceof HttpError) {
    return res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details } });
  }
  if (err?.type === 'entity.parse.failed') {
    return res.status(400).json({ error: { code: 'INVALID_JSON', message: 'Request body is not valid JSON' } });
  }
  if (err?.code === '23505') {
    return res.status(409).json({ error: { code: 'DUPLICATE', message: 'A record with these details already exists' } });
  }
  if (err?.code === '22P02') {
    return res.status(400).json({ error: { code: 'BAD_ID', message: 'Invalid identifier' } });
  }
  if (!env.isTest) console.error(err);
  res.status(500).json({ error: { code: 'INTERNAL', message: 'Something went wrong' } });
}
