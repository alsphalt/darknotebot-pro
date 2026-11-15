import { redirect } from "next/navigation";
import { currentUser } from "@/lib/auth/session";
import { AppShell } from "@/components/app-shell";
import { ServerProvider, ToastProvider } from "@/components/providers";

export const dynamic = "force-dynamic";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await currentUser();
  if (!user) redirect("/login");

  return (
    <ToastProvider>
      <ServerProvider>
        <AppShell user={{ name: user.name, email: user.email, role: user.role }}>{children}</AppShell>
      </ServerProvider>
    </ToastProvider>
  );
}
