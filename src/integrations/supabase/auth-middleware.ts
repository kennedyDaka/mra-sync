// Server-side auth middleware — validates Supabase JWTs on server functions.
import { createMiddleware } from '@tanstack/react-start'
import { getRequest } from '@tanstack/react-start/server'
import { createClient } from '@supabase/supabase-js'
import type { Database } from './types'

function extractJwtFromCookie(cookieHeader: string | null, cookieName: string): string | null {
  if (!cookieHeader) return null;
  const match = cookieHeader.match(new RegExp(`(^|;\\s*)${cookieName}=([^;]+)`));
  if (!match) return null;
  const raw = decodeURIComponent(match[2]);
  // Supabase stores a JSON object with { current_token: "..." } in the cookie
  try {
    const parsed = JSON.parse(raw);
    return parsed?.current_token ?? parsed?.access_token ?? raw;
  } catch {
    return raw;
  }
}

export const requireSupabaseAuth = createMiddleware({ type: 'function' }).server(
  async ({ next }) => {
    const SUPABASE_URL = process.env['SUPABASE_URL'];
    const SUPABASE_ANON_KEY = process.env['SUPABASE_ANON_KEY'];

    if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
      const missing = [
        ...(!SUPABASE_URL ? ['SUPABASE_URL'] : []),
        ...(!SUPABASE_ANON_KEY ? ['SUPABASE_ANON_KEY'] : []),
      ];
      const message = `Missing Supabase environment variable(s): ${missing.join(', ')}. Set them in your .env or Vercel dashboard.`;
      console.error(`[Supabase] ${message}`);
      throw new Error(message);
    }
    
    const request = getRequest();

    if (!request?.headers) {
      throw new Error('Unauthorized: No request headers available');
    }

    // Try Authorization header first
    let token: string | null = null;
    const authHeader = request.headers.get('authorization');
    if (authHeader?.startsWith('Bearer ')) {
      token = authHeader.replace('Bearer ', '');
    }

    // Fall back to Supabase auth cookie (used by useServerFn calls)
    if (!token) {
      const cookieHeader = request.headers.get('cookie');
      // Supabase cookie name format: sb-<project-ref>-auth-token
      const projectRef = SUPABASE_URL.replace(/.*\/([a-z]+)\.supabase\.co/, '$1');
      const cookieName = `sb-${projectRef}-auth-token`;
      token = extractJwtFromCookie(cookieHeader, cookieName);
    }

    if (!token) {
      throw new Error('Unauthorized: No authorization header or session cookie provided');
    }

    const supabase = createClient<Database>(
      SUPABASE_URL,
      SUPABASE_ANON_KEY,
      {
        global: {
          headers: {
            Authorization: `Bearer ${token}`,
          },
        },
        auth: {
          storage: undefined,
          persistSession: false,
          autoRefreshToken: false,
        },
      }
    );

    const { data, error } = await supabase.auth.getUser(token);
    if (error || !data?.user) {
      throw new Error('Unauthorized: Invalid token');
    }

    return next({
      context: {
        supabase,
        userId: data.user.id,
        user: data.user,
      },
    });
  },
);
