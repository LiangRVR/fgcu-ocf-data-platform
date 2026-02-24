import { redirect } from "next/navigation";
import { IS_AUTHED } from "@/lib/auth/mock";
import { DashboardShell } from "@/components/layout/dashboard-shell";

/**
 * Dashboard route group layout.
 *
 * Auth gate: reads `IS_AUTHED` from lib/auth/mock.ts.
 * Swap that import for a real Supabase session check when ready.
 */
export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // Server-side auth gate — replace once Supabase session is wired up
  if (!IS_AUTHED) {
    redirect("/login");
  }

  return <DashboardShell>{children}</DashboardShell>;
}
