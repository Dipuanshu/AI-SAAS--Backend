import { query } from '../../db/pool';

export interface AiSettings {
  about: string;
  allowDelete: boolean;
  redactFields: string[];
}

export async function getSettings(companyId: string): Promise<AiSettings> {
  await query('INSERT INTO ai_settings (company_id) VALUES ($1) ON CONFLICT DO NOTHING', [companyId]);
  const r = (await query('SELECT * FROM ai_settings WHERE company_id = $1', [companyId])).rows[0];
  return { about: r.about, allowDelete: r.allow_delete, redactFields: r.redact_fields };
}
