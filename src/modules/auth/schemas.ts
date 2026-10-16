import { z } from 'zod';

export const passwordSchema = z
  .string()
  .min(8, 'must be at least 8 characters')
  .max(100)
  .refine((p) => /[A-Za-z]/.test(p) && /\d/.test(p), 'must contain letters and numbers');

const email = z.string().trim().toLowerCase().pipe(z.email('must be a valid email'));

export const registerCompanySchema = z.object({
  companyName: z.string().trim().min(2).max(120),
  companyPhone: z.string().trim().max(30).optional(),
  adminName: z.string().trim().min(2).max(100),
  email,
  password: passwordSchema,
  planCode: z.string().trim().max(50).optional(),
});

export const loginSchema = z.object({
  companySlug: z.string().trim().toLowerCase().min(1),
  email,
  password: z.string().min(1).max(100),
});

export const adminLoginSchema = z.object({ email, password: z.string().min(1).max(100) });
export const refreshSchema = z.object({ refreshToken: z.string().min(10) });
export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: passwordSchema,
});
export const emailSchema = email;
