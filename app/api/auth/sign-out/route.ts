import { NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase/server";

export async function POST() {
  try {
    const supabase = createServerClient();

    const { error } = await supabase.auth.signOut();

    if (error) {
      // Masked below through the same generic path as thrown provider errors.
      throw error;
    }

    return NextResponse.json({ success: true });
  } catch {
    // Server-side trace only: never echo the provider's raw message (it can
    // carry PII/credentials) into logs or responses. This also covers thrown
    // provider/network rejections.
    console.error("[api:auth:sign-out] Failed to sign out.");
    return NextResponse.json(
      { success: false, message: "Unable to sign out." },
      { status: 500 }
    );
  }
}
