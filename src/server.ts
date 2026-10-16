import { createApp } from './app';
import { env } from './config/env';
import { migrate } from './db/migrate';
import { pool } from './db/pool';

async function main() {
  await migrate();
  const app = createApp();
  const server = app.listen(env.port, () => console.log(`API listening on http://localhost:${env.port}`));

  const shutdown = () => {
    server.close(() => pool.end().then(() => process.exit(0)));
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('Failed to start', err);
  process.exit(1);
});
