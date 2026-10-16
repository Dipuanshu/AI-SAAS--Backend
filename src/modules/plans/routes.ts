import { Router } from 'express';
import { query } from '../../db/pool';

export const publicPlansRouter = Router();

export function mapPlan(r: any) {
  return {
    id: r.id,
    code: r.code,
    name: r.name,
    description: r.description,
    priceMonthly: Number(r.price_monthly),
    priceYearly: Number(r.price_yearly),
    currency: r.currency,
    maxUsers: r.max_users,
    features: r.features ?? [],
    isActive: r.is_active,
    sortOrder: r.sort_order,
  };
}

// Public: shown on the "register company" screen.
publicPlansRouter.get('/', async (_req, res) => {
  const { rows } = await query('SELECT * FROM plans WHERE is_active = true ORDER BY sort_order, price_monthly');
  res.json({ plans: rows.map(mapPlan) });
});
