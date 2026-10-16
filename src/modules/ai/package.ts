import fs from 'fs';
import path from 'path';
import { env } from '../../config/env';
import { createZip, ZipEntry } from '../../services/zip';
import { buildReadme } from './guide';
import { makeConnectorKey } from './connectorKey';

// src/modules/ai -> project root /connector (works for both ts-node/tsx and the compiled dist/ layout)
const CONNECTOR_DIR = path.resolve(__dirname, '../../../connector');
const read = (...p: string[]) => fs.readFileSync(path.join(CONNECTOR_DIR, ...p));

export function buildConnectorPackage(opts: { connectorId: string; keyVersion: number; companyName: string; stack: string | null }): Buffer {
  const key = makeConnectorKey(opts.connectorId, opts.keyVersion);
  const dotenv = `# AI SaaS connection -- keep this file private
AISAAS_URL=${env.publicApiUrl}
AISAAS_CONNECTOR_KEY=${key}

# Where your own backend runs (the connector calls this address)
BACKEND_URL=http://localhost:3000

# Where your backend publishes its OpenAPI/Swagger JSON. Leave empty to auto-detect common locations.
OPENAPI_URL=
# OPENAPI_FILE=./openapi.json
# POSTMAN_FILE=./my-collection.json
`;
  const config = {
    auth: {
      mode: 'login',
      login: { path: '/auth/login', method: 'POST', contentType: 'json', body: { email: '{{username}}', password: '{{password}}' }, tokenPath: 'token', header: 'Authorization', prefix: 'Bearer ', sessionMinutes: 480 },
      static: { header: 'Authorization', value: '' },
    },
    redactFields: ['password', 'passwordHash', 'password_hash', 'token', 'accessToken', 'refreshToken', 'secret', 'apiKey', 'api_key'],
    record: { enabled: false, port: 9090 },
  };
  const entries: ZipEntry[] = [
    { name: 'ai-connector/connector.js', data: read('connector.js'), mode: 0o755 },
    { name: 'ai-connector/package.json', data: read('package.json') },
    { name: 'ai-connector/.env', data: dotenv, mode: 0o600 },
    { name: 'ai-connector/connector.config.json', data: JSON.stringify(config, null, 2) + '\n' },
    { name: 'ai-connector/Dockerfile', data: read('Dockerfile') },
    { name: 'ai-connector/docker-compose.yml', data: read('docker-compose.yml') },
    { name: 'ai-connector/.gitignore', data: '.env\nnode_modules\n' },
    { name: 'ai-connector/README.md', data: buildReadme(opts.stack, opts.companyName) },
    { name: 'ai-connector/examples/demo-api/server.js', data: read('examples', 'demo-api', 'server.js') },
  ];
  return createZip(entries);
}
