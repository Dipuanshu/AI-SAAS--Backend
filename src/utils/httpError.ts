export class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

export const badRequest = (message: string, code = 'BAD_REQUEST', details?: unknown) => new HttpError(400, code, message, details);
export const unauthorized = (message = 'Authentication required', code = 'UNAUTHORIZED') => new HttpError(401, code, message);
export const forbidden = (message = 'You do not have permission to do this', code = 'FORBIDDEN') => new HttpError(403, code, message);
export const notFound = (message = 'Not found') => new HttpError(404, 'NOT_FOUND', message);
export const conflict = (message: string, code = 'CONFLICT') => new HttpError(409, code, message);
