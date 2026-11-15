import 'server-only';
import { NextResponse, type NextRequest } from 'next/server';
import { ZodError, type ZodSchema } from 'zod';
import { currentCsrfToken, requirePermission, requireUser, type SessionUser } from './auth/session';
import type { Permission } from './auth/permissions';
import { PterodactylError } from './pterodactyl/client';
import { PathError } from './security/paths';

export class ApiError extends Error {
  status: number;
  code: string;
  details?: unknown;
  constructor(message: string, status = 400, code = 'bad_request', details?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function ok<T>(data: T, init?: ResponseInit): NextResponse {
  return NextResponse.json({ ok: true, data }, init);
}

export function fail(error: unknown): NextResponse {
  if (error instanceof ApiError) {
    return NextResponse.json(
      { ok: false, error: error.message, code: error.code, details: error.details },
      { status: error.status },
    );
  }
  if (error instanceof ZodError) {
    return NextResponse.json(
      {
        ok: false,
        error: 'Validation failed',
        code: 'validation_error',
        details: error.issues.map((issue) => `${issue.path.join('.') || 'body'}: ${issue.message}`),
      },
      { status: 422 },
    );
  }
  if (error instanceof PathError) {
    return NextResponse.json({ ok: false, error: error.message, code: 'unsafe_path' }, { status: 400 });
  }
  if (error instanceof PterodactylError) {
    const status = error.isAuthError ? 424 : error.isNotFound ? 404 : error.isRateLimited ? 429 : 502;
    return NextResponse.json(
      {
        ok: false,
        error: error.message,
        code: error.code,
        details: { status: error.status, endpoint: error.endpoint },
      },
      { status },
    );
  }
  const statusCode = (error as { statusCode?: number })?.statusCode;
  if (statusCode === 401) {
    return NextResponse.json({ ok: false, error: 'Not authenticated', code: 'unauthenticated' }, { status: 401 });
  }
  if (statusCode === 403) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : 'Forbidden', code: 'forbidden' },
      { status: 403 },
    );
  }
  const message = error instanceof Error ? error.message : 'Unexpected server error';
  if (process.env.NODE_ENV !== 'production') {
    // eslint-disable-next-line no-console
    console.error('[darknote] api error:', error);
  }
  return NextResponse.json({ ok: false, error: message, code: 'server_error' }, { status: 500 });
}

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

async function assertCsrf(req: NextRequest): Promise<void> {
  if (!MUTATING.has(req.method)) return;
  const header = req.headers.get('x-csrf-token');
  const expected = await currentCsrfToken();
  if (!expected || !header || header !== expected) {
    throw new ApiError('CSRF validation failed. Reload the page and try again.', 403, 'csrf_failed');
  }
  const origin = req.headers.get('origin');
  if (origin) {
    const host = req.headers.get('host');
    try {
      if (new URL(origin).host !== host) {
        throw new ApiError('Cross-origin request rejected.', 403, 'bad_origin');
      }
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError('Invalid Origin header.', 403, 'bad_origin');
    }
  }
}

type Params = Record<string, string>;

interface HandlerArgs<P extends Params> {
  req: NextRequest;
  user: SessionUser;
  params: P;
  body: <T>(schema: ZodSchema<T>) => Promise<T>;
}

export function route<P extends Params = Params>(
  options: { permission: Permission | null; csrf?: boolean },
  handler: (args: HandlerArgs<P>) => Promise<Response>,
) {
  return async (req: NextRequest, ctx: { params: Promise<P> }): Promise<Response> => {
    try {
      if (options.csrf !== false) await assertCsrf(req);
      const user = options.permission ? await requirePermission(options.permission) : await requireUser();
      const params = ctx?.params ? await ctx.params : ({} as P);
      const body = async <T>(schema: ZodSchema<T>): Promise<T> => {
        let raw: unknown;
        try {
          raw = await req.json();
        } catch {
          raw = {};
        }
        return schema.parse(raw);
      };
      return await handler({ req, user, params, body });
    } catch (error) {
      return fail(error);
    }
  };
}

export function publicRoute(handler: (req: NextRequest) => Promise<Response>) {
  return async (req: NextRequest): Promise<Response> => {
    try {
      return await handler(req);
    } catch (error) {
      return fail(error);
    }
  };
}

/** Small in-process limiter; keeps a single client from hammering the panel. */
const buckets = new Map<string, { count: number; resetAt: number }>();

export function rateLimit(key: string, limit: number, windowMs: number): void {
  const now = Date.now();
  const bucket = buckets.get(key);
  if (!bucket || bucket.resetAt < now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return;
  }
  bucket.count += 1;
  if (bucket.count > limit) {
    throw new ApiError('Slow down — too many requests. Try again shortly.', 429, 'rate_limited');
  }
}

export function searchParams(req: NextRequest): URLSearchParams {
  return new URL(req.url).searchParams;
}
