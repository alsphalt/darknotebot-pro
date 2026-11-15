import bcrypt from 'bcryptjs';

const ROUNDS = 12;

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, ROUNDS);
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  try {
    return await bcrypt.compare(password, hash);
  } catch {
    return false;
  }
}

export function passwordProblems(password: string): string[] {
  const problems: string[] = [];
  if (password.length < 12) problems.push('Must be at least 12 characters long');
  if (!/[A-Z]/.test(password)) problems.push('Must include an uppercase letter');
  if (!/[a-z]/.test(password)) problems.push('Must include a lowercase letter');
  if (!/[0-9]/.test(password)) problems.push('Must include a number');
  if (!/[^A-Za-z0-9]/.test(password)) problems.push('Must include a symbol');
  return problems;
}
