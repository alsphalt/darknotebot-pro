import { NextRequest } from 'next/server';
import { assertServerAccess } from '@/lib/servers/repo';
import { requireUser } from '@/lib/auth/session';
import { captureConsole, consoleBuffer } from '@/lib/services/console';
import { fail, ApiError } from '@/lib/api';
import { classifyLine } from '@/lib/views';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

/**
 * Server-Sent Events carrying real panel console output.
 *
 * The backend attaches to the Pterodactyl websocket and forwards whatever the
 * server actually printed. When the panel cannot be attached the stream says so
 * with an `error` event instead of inventing output.
 */
export async function GET(req: NextRequest): Promise<Response> {
  try {
    const user = await requireUser();
    const serverId = req.nextUrl.searchParams.get('serverId');
    if (!serverId) throw new ApiError('serverId is required', 400, 'server_required');
    const server = await assertServerAccess(user, serverId, 'console.read');

    const encoder = new TextEncoder();
    let closed = false;
    let seen = 0;

    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const send = (event: string, data: unknown) => {
          if (closed) return;
          try {
            controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
          } catch {
            closed = true;
          }
        };

        const backlog = consoleBuffer(server.id).lines;
        send('ready', { serverId: server.id, backlog: backlog.length, transport: 'sse', source: 'pterodactyl websocket' });
        for (const text of backlog.slice(-200)) {
          send('line', { ts: Date.now(), text, level: classifyLine(text) });
        }
        seen = backlog.length;

        // Poll the panel websocket in bounded windows and forward new lines only.
        while (!closed) {
          const capture = await captureConsole(server, 6000);
          if (capture.error) {
            send('error', { message: capture.error });
          }
          const lines = capture.lines.length ? capture.lines : consoleBuffer(server.id).lines;
          if (lines.length < seen) seen = 0;
          for (const text of lines.slice(seen)) {
            send('line', { ts: Date.now(), text, level: classifyLine(text) });
          }
          seen = lines.length;
          await new Promise((resolve) => setTimeout(resolve, 1000));
        }
      },
      cancel() {
        closed = true;
      },
    });

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      },
    });
  } catch (error) {
    return fail(error);
  }
}
