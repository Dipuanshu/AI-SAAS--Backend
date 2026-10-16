import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import morgan from 'morgan';
import { env } from './config/env';
import { pool } from './db/pool';
import { errorHandler, notFoundHandler } from './middleware/error';
import { adminRouter } from './modules/admin/routes';
import { authRouter } from './modules/auth/routes';
import { companyRouter } from './modules/company/routes';
import { publicPlansRouter } from './modules/plans/routes';

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  if (env.isProd) app.set('trust proxy', 1);

  app.use(helmet());
  app.use(
    cors({
      origin: env.corsOrigins.includes('*') ? true : env.corsOrigins,
      credentials: true,
    }),
  );
  if (!env.isTest) app.use(morgan(env.isProd ? 'combined' : 'dev'));
  app.use(express.json({ limit: '1mb' }));

  app.get('/health', async (_req, res) => {
    await pool.query('SELECT 1');
    res.json({ status: 'ok', time: new Date().toISOString() });
  });

  app.use('/api/plans', publicPlansRouter);
  app.use('/api/auth', authRouter);
  app.use('/api/company', companyRouter);
  app.use('/api/admin', adminRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
