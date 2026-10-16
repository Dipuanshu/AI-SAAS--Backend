INSERT INTO plans (code, name, description, price_monthly, price_yearly, max_users, features, sort_order) VALUES
  ('starter', 'Starter', 'For small teams getting started with AI automation',
    999, 9990, 5, '["AI help chat","Up to 5 users","Email support"]', 1),
  ('growth', 'Growth', 'For growing companies that need more people and automation',
    2999, 29990, 25, '["AI help chat","AI automation (tool calling)","Up to 25 users","Priority support"]', 2),
  ('enterprise', 'Enterprise', 'For large organisations with advanced needs',
    9999, 99990, 200, '["Everything in Growth","Up to 200 users","Audit logs","Dedicated support"]', 3)
ON CONFLICT (code) DO NOTHING;
