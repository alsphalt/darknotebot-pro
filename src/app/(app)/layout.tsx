import { redirect } from "next/navigation";
import { currentUser } from "@/lib/auth/session";
import { AppShell } from "@/components/app-shell";
import { CrashSentinel } from "@/components/crash-sentinel";
import { ErrorBoundary } from "@/components/error-boundary";
import { ServerProvider, ToastProvider } from "@/components/providers";

export const dynamic = "force-dynamic";

/**
 * Authenticated shell.
 *
 * `CrashSentinel` is mounted here rather than in the root layout so it only runs
 * for signed-in sessions (it reports to an authenticated endpoint) and never
 * competes with the login page for the first paint. It renders nothing.
 */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await currentUser();
  if (!user) redirect("/login");

  return (
    <ToastProvider>
      <ServerProvider>
        <AppShell user={{ name: user.name, email: user.email, role: user.role }}>
          {/* A page that throws must not take the navigation, the session or
              the console chrome down with it. */}
          <ErrorBoundary scope="This page">{children}</ErrorBoundary>
        </AppShell>
        <CrashSentinel />
      </ServerProvider>
    </ToastProvider>
  );
}
