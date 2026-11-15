import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';

/**
 * Central environment access. Nothing here throws at import time so that the
 * Next.js build never depends on runtime secrets being present.
 */
const dataDir = process.env.DARKNOTE_DATA_DIR
  ? path.resolve(process.env.DARKNOTE_DATA_DIR)
  : path.join(process.cwd(), '.data');

export const env = {
  nodeEnv: process.env.NODE_ENV ?? 'development',
  isProd: process.env.NODE_ENV === 'production',
  dataDir,
  backupDir: path.join(dataDir, 'backups'),
  uploadDir: path.join(dataDir, 'uploads'),
  pgliteDir: path.join(dataDir, 'pglite'),

  databaseUrl: process.env.DATABASE_URL ?? '',
  databaseSsl: (process.env.DATABASE_SSL ?? 'require').toLowerCase(),
  dbDriver: (process.env.DARKNOTE_DB_DRIVER ?? 'auto').toLowerCase() as 'auto' | 'neon' | 'pglite',

  adminEmail: process.env.DARKNOTE_ADMIN_EMAIL ?? '',
  adminPassword: process.env.DARKNOTE_ADMIN_PASSWORD ?? '',
  adminName: process.env.DARKNOTE_ADMIN_NAME ?? 'Administrator',

  /** Used for session token hashing + AES-256-GCM credential encryption. */
  secret: process.env.DARKNOTE_SECRET ?? '',

  sessionHours: Number(process.env.DARKNOTE_SESSION_HOURS ?? 12),
  loginMaxAttempts: Number(process.env.DARKNOTE_LOGIN_MAX_ATTEMPTS ?? 8),
  loginWindowMinutes: Number(process.env.DARKNOTE_LOGIN_WINDOW_MINUTES ?? 15),

  /** Global safety rails for remote operations. */
  maxIndexFiles: Number(process.env.DARKNOTE_MAX_INDEX_FILES ?? 4000),
  maxIndexDepth: Number(process.env.DARKNOTE_MAX_INDEX_DEPTH ?? 10),
  maxDownloadBytes: Number(process.env.DARKNOTE_MAX_DOWNLOAD_BYTES ?? 96 * 1024 * 1024),
  maxSearchResults: Number(process.env.DARKNOTE_MAX_SEARCH_RESULTS ?? 400),

  trustProxy: process.env.DARKNOTE_TRUST_PROXY === '1',
  appUrl: process.env.DARKNOTE_APP_URL ?? '',
};

export function ensureDataDirs(): void {
  for (const dir of [env.dataDir, env.backupDir, env.uploadDir]) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
}

let cachedSecret: string | null = null;

/**
 * Secrets must be stable between restarts, otherwise sessions and encrypted
 * panel credentials break. In production DARKNOTE_SECRET is mandatory; in
 * development we persist a generated key inside the private data directory.
 */
export function appSecret(): string {
  if (cachedSecret) return cachedSecret;
  if (env.secret && env.secret.length >= 24) {
    cachedSecret = env.secret;
    return cachedSecret;
  }
  if (env.isProd) {
    throw new Error(
      'DARKNOTE_SECRET is not configured. Set a random 32+ character value (openssl rand -base64 48) before starting in production.',
    );
  }
  ensureDataDirs();
  const keyFile = path.join(env.dataDir, 'dev-secret.key');
  if (fs.existsSync(keyFile)) {
    cachedSecret = fs.readFileSync(keyFile, 'utf8').trim();
    return cachedSecret;
  }
  const generated = crypto.randomBytes(48).toString('base64');
  fs.writeFileSync(keyFile, generated, { mode: 0o600 });
  // eslint-disable-next-line no-console
  console.warn('[darknote] DARKNOTE_SECRET not set — generated a development key at .data/dev-secret.key');
  cachedSecret = generated;
  return generated;
}

export function warnMissingConfig(): string[] {
  const missing: string[] = [];
  if (!env.databaseUrl && env.dbDriver !== 'pglite') {
    missing.push('DATABASE_URL (Neon PostgreSQL) — currently using the embedded PGlite development database');
  }
  if (!env.secret) missing.push('DARKNOTE_SECRET — session signing and credential encryption key');
  if (!env.adminEmail || !env.adminPassword) {
    missing.push('DARKNOTE_ADMIN_EMAIL / DARKNOTE_ADMIN_PASSWORD — first-run administrator bootstrap');
  }
  return missing;
}
