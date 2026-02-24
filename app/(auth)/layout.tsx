/**
 * Auth route group layout — minimal, centered layout for login/reset pages.
 * No sidebar or top bar.
 */
export default function AuthLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-muted/30 px-4">
      {children}
    </div>
  );
}
