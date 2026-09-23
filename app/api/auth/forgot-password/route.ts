import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase/server";
import { getResetPasswordRedirectUrl } from "@/lib/config/app";
import { forgotPasswordSchema } from "@/lib/validators/account";

export async function POST(request: NextRequest) {
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

  try {
    // Server-controlled origin only: the client request origin (Host header)
    // is never consulted, so a malicious origin cannot redirect reset links.
    // The origin is REQUIRED server configuration (`APP_URL`); missing or
    // invalid config throws and is masked below like any provider failure.
    const redirectTo = getResetPasswordRedirectUrl();
    const supabase = createServerClient();
    const { error } = await supabase.auth.resetPasswordForEmail(
      parsed.data.email,
      { redirectTo }
    );

    if (error) {
      // Masked below through the same generic path as thrown provider errors.
      throw error;
    }

    return NextResponse.json({ success: true });
  } catch {
    // Server-side trace only: never echo the provider's raw message (it can
    // carry PII/credentials) into logs or responses. This also covers thrown
    // provider/network rejections and reset-origin configuration failures.
    console.error("[api:auth:forgot-password] Failed to send password reset email.");
    return NextResponse.json(
      { error: "Unable to send reset email." },
      { status: 500 }
    );
  }
}
