import { NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase/server";
import { forgotPasswordSchema } from "@/lib/validators/account";

export async function POST(request: Request) {
  const payload = await request.json().catch(() => null);
  const parsed = forgotPasswordSchema.safeParse(payload);

  if (!parsed.success) {
    return NextResponse.json(
      {
        error: parsed.error.issues[0]?.message ?? "Enter a valid email address.",
      },
      { status: 400 }
    );
  }

  const supabase = createServerClient();
  const redirectTo = `${request.nextUrl.origin}/reset-password`;
  const { error } = await supabase.auth.resetPasswordForEmail(parsed.data.email, {
    redirectTo,
  });

  if (error) {
    return NextResponse.json(
      { error: error.message || "Unable to send reset email." },
      { status: 500 }
    );
  }

  return NextResponse.json({ success: true });
}
