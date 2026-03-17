import { LoginForm } from "@/components/auth/login-form";

interface LoginPageProps {
  searchParams: Promise<{ reason?: string }>;
}

export default async function LoginPage({ searchParams }: LoginPageProps) {
  const { reason } = await searchParams;
  const reasonMessage =
    reason === "inactive"
      ? "Your advisor account is inactive. Contact your OCF administrator."
      : reason === "unauthorized"
        ? "Your account is signed in but is not linked to an active advisor profile."
        : null;

  return <LoginForm reasonMessage={reasonMessage} />;
}
