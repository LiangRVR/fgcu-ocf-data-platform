import { requireAdvisor } from "@/lib/auth/session";
import { DashboardShell } from "@/components/layout/dashboard-shell";

/**
 * Dashboard route group layout.
 *
 * The dashboard is protected by a server-side Supabase session and advisor lookup.
 */
export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const advisor = await requireAdvisor();

  return <DashboardShell advisor={advisor}>{children}</DashboardShell>;
}
