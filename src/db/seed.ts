import { env } from '../config/env';
import { migrate } from './migrate';
import { pool, query } from './pool';
import { hashPassword } from '../utils/password';

/** Creates (or resets the password of) the platform Super Admin from env vars. */
export async function seedSuperAdmin(): Promise<void> {
  const { name, email, password } = env.superAdmin;
  if (!email || !password) throw new Error('Set SUPER_ADMIN_EMAIL and SUPER_ADMIN_PASSWORD in .env first');
  if (password.length < 8) throw new Error('SUPER_ADMIN_PASSWORD must be at least 8 characters');
  const hash = await hashPassword(password);
  const existing = await query(`SELECT id FROM users WHERE company_id IS NULL AND email = $1`, [email]);
  if (existing.rowCount) {
    await query(`UPDATE users SET password_hash = $2, name = $3, is_active = true, updated_at = now() WHERE id = $1`, [existing.rows[0].id, hash, name]);
    console.log(`Super admin ${email} updated`);
  } else {
    await query(`INSERT INTO users (company_id, name, email, password_hash, role) VALUES (NULL,$1,$2,$3,'super_admin')`, [name, email, hash]);
    console.log(`Super admin ${email} created`);
  }
}

if (require.main === module) {
  migrate(false)
    .then(seedSuperAdmin)
    .then(() => pool.end())
    .catch((e) => {
      console.error(e.message);
      process.exit(1);
    });
}
