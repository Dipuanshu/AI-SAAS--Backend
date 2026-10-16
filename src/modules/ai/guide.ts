// Setup guide shown in the app and written into the downloaded package (README.md).
// One connector works for every language; only the "describe your API" step depends on the stack.

export interface Stack {
  id: string;
  label: string;
  /** How to make this stack publish an OpenAPI/Swagger JSON. */
  howTo: string[];
  /** Where that JSON usually lives (the connector also probes common locations automatically). */
  specPath: string;
}

export const STACKS: Stack[] = [
  { id: 'node-express', label: 'Node.js – Express', specPath: '/openapi.json',
    howTo: ['Easiest: install `express-oas-generator` (builds the spec from your existing routes, no annotations): `npm i express-oas-generator`.', 'Or write the spec with `swagger-jsdoc` and serve it as JSON at `/openapi.json`.', 'No spec at all? Use Record mode (see "No OpenAPI?" below).'] },
  { id: 'nestjs', label: 'Node.js – NestJS', specPath: '/api-json',
    howTo: ['Install `@nestjs/swagger` and in main.ts: `SwaggerModule.setup("api", app, SwaggerModule.createDocument(app, new DocumentBuilder().build()))`.', 'The JSON is then served at `/api-json`.'] },
  { id: 'python-fastapi', label: 'Python – FastAPI', specPath: '/openapi.json',
    howTo: ['Nothing to do: FastAPI already serves `/openapi.json`.'] },
  { id: 'python-django', label: 'Python – Django / DRF', specPath: '/api/schema/?format=json',
    howTo: ['Install `drf-spectacular` and add `path("api/schema/", SpectacularAPIView.as_view())` to urls.py.', 'Open `/api/schema/?format=json` to check the JSON.'] },
  { id: 'python-flask', label: 'Python – Flask', specPath: '/openapi.json',
    howTo: ['Use `flask-smorest` or `flasgger` / `apispec` to publish the spec as JSON.', 'No annotations in your code? Use Record mode.'] },
  { id: 'php-laravel', label: 'PHP – Laravel', specPath: '/docs/api.json',
    howTo: ['Install `dedoc/scramble` (generates the spec automatically; JSON at `/docs/api.json`) or `darkaonline/l5-swagger`.'] },
  { id: 'php-other', label: 'PHP – other / plain PHP', specPath: '/openapi.json',
    howTo: ['Export a Postman collection of your API, or use Record mode.'] },
  { id: 'java-spring', label: 'Java – Spring Boot', specPath: '/v3/api-docs',
    howTo: ['Add the dependency `org.springdoc:springdoc-openapi-starter-webmvc-ui`.', 'The spec is served at `/v3/api-docs` automatically.'] },
  { id: 'dotnet', label: '.NET / ASP.NET Core', specPath: '/swagger/v1/swagger.json',
    howTo: ['Add `Swashbuckle.AspNetCore` (`builder.Services.AddSwaggerGen()` + `app.UseSwagger()`).', 'The spec is served at `/swagger/v1/swagger.json`.'] },
  { id: 'go', label: 'Go', specPath: '/swagger/doc.json',
    howTo: ['Use `swaggo/swag` (`swag init`) – it creates `docs/swagger.json`.', 'Set `OPENAPI_FILE=./docs/swagger.json` in .env, or serve it with gin-swagger / http-swagger.'] },
  { id: 'ruby-rails', label: 'Ruby on Rails', specPath: '/api-docs/v1/swagger.json',
    howTo: ['Use `rswag` and generate the spec as JSON (`swagger_format: :json`).'] },
  { id: 'other', label: 'Other / not sure', specPath: '/openapi.json',
    howTo: ['Any framework works if it can publish an OpenAPI/Swagger JSON.', 'Otherwise export a Postman collection or use Record mode.'] },
];

export const stackById = (id: string | null | undefined): Stack => STACKS.find((s) => s.id === id) ?? STACKS[STACKS.length - 1]!;

export interface GuideStep {
  id: string;
  title: string;
  text: string;
  code?: string;
}

export function buildGuide(stackId: string | null | undefined): { stack: Stack; steps: GuideStep[] } {
  const stack = stackById(stackId);
  const steps: GuideStep[] = [
    {
      id: 'download',
      title: '1. Download the connector',
      text: 'One small program that works with every backend language. It runs next to your software, learns your API routes (names and parameters only – never your source code) and lets the AI call them for your users. It only makes outbound connections, so no firewall port needs to be opened.',
    },
    {
      id: 'place',
      title: '2. Put it on a computer that can reach your backend',
      text: 'Unzip it on the same server as your backend (or any machine on the same network). You need Node.js 18+ OR Docker – this is only for the connector; your backend can be in any language.\nIf it runs on a different machine than this platform, open .env and set AISAAS_URL to this platform\'s public address (the machine must be able to reach it).',
      code: 'cd ai-connector\nnode connector.js --check      # tests everything\n# or with Docker:\ndocker compose up -d',
    },
    {
      id: 'describe',
      title: `3. Let your ${stack.label} backend describe its API`,
      text: `${stack.howTo.join('\n')}\n\nUsually the JSON is at "${stack.specPath}". The connector tries the common locations automatically. If yours is elsewhere, set OPENAPI_URL in .env.`,
    },
    {
      id: 'norest',
      title: 'No OpenAPI? Two alternatives',
      text: 'Postman: export your collection as JSON and set POSTMAN_FILE=./my-collection.json in .env.\nRecord mode: set "record": {"enabled": true} in connector.config.json, then use your app (or Postman) through http://localhost:9090 for a few minutes – the connector learns the routes from the traffic (method, path, parameter names, field types – never values).',
    },
    {
      id: 'config',
      title: '4. Tell it how your users log in',
      text: 'Edit .env (BACKEND_URL = where your backend runs) and connector.config.json ("auth"):\n• login (recommended): each employee signs in to the assistant with their normal software login. Calls then run with THEIR permissions, so your own role rules always apply. Set "auth.login.path" to your login route and "tokenPath" to where the token is in the response.\n• static: one service API key for everything. Your backend then cannot tell users apart, so the app\'s role settings are the only protection: new tools start switched off and admin-only.\n• none: your API needs no login.',
      code: '{\n  "auth": {\n    "mode": "login",\n    "login": { "path": "/auth/login", "body": { "email": "{{username}}", "password": "{{password}}" }, "tokenPath": "token" }\n  }\n}',
    },
    {
      id: 'run',
      title: '5. Start it',
      text: 'Run it and keep it running (pm2, systemd, Docker – anything). When it says "Connected", come back to the app: the status turns green and your routes appear under Setup → API tools.',
      code: 'node connector.js',
    },
    {
      id: 'review',
      title: '6. Review the tools (do not skip)',
      text: 'In the app open Setup → API tools. Read-only routes are on by default, anything that changes data is off. Improve unclear descriptions (the AI chooses tools by reading them), choose which roles may use each tool, and enable what you want. Deleting is blocked unless you allow it in AI settings.',
    },
    {
      id: 'test',
      title: '7. Test',
      text: 'Open the Assistant tab, sign in as different roles and ask questions about your software. Changes (add / update / delete) always ask for confirmation first, and everything is logged.',
    },
  ];
  return { stack, steps };
}

export function buildReadme(stackId: string | null | undefined, companyName: string): string {
  const { steps } = buildGuide(stackId);
  const body = steps
    .map((s) => `## ${s.title}\n\n${s.text}${s.code ? `\n\n\`\`\`\n${s.code}\n\`\`\`` : ''}`)
    .join('\n\n');
  return `# AI Connector for ${companyName}

Generated by AI SaaS. **Keep \`.env\` private** – it contains your connector key.

${body}

## Files

- \`connector.js\` – the connector (no dependencies)
- \`.env\` – SaaS address + your key, backend address, spec location
- \`connector.config.json\` – login mode, redacted fields, record mode
- \`Dockerfile\`, \`docker-compose.yml\` – run it in Docker (use \`BACKEND_URL=http://host.docker.internal:3000\`)
- \`examples/demo-api/server.js\` – a tiny demo backend to try everything (\`node examples/demo-api/server.js\`, then set BACKEND_URL=http://localhost:3100 and AUTH login as in the demo header)

## Security

- The connector only talks OUT to the AI SaaS and to the BACKEND_URL you configured. It cannot be told to call any other address.
- Passwords entered by users are used once to log in to YOUR backend and are never stored; the resulting token stays in this process's memory.
- Add field names to \`redactFields\` to strip them from every answer before it leaves your network.
- Lost key or leaked file? Rotate it in the app (Setup → Connector) and update \`.env\`.
`;
}
