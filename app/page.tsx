import { redirect } from "next/navigation";

/**
 * Root route — redirect to the main dashboard.
 * Replace with a real auth check once Supabase auth is wired up.
 */
export default function RootPage() {
  redirect("/dashboard");
}
