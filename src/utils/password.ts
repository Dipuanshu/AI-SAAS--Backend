import bcrypt from 'bcryptjs';

const COST = 11;
// Compared against when a user is not found so login timing does not reveal which emails exist.
const DUMMY_HASH = bcrypt.hashSync('dummy-password-for-timing', COST);

export const hashPassword = (plain: string) => bcrypt.hash(plain, COST);

export async function verifyPassword(plain: string, hash: string | null | undefined): Promise<boolean> {
  const ok = await bcrypt.compare(plain, hash ?? DUMMY_HASH);
  return hash ? ok : false;
}
