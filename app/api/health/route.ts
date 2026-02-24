import { NextResponse } from "next/server";

/**
 * GET /api/health — lightweight health check endpoint.
 * Useful for uptime monitors and CI checks.
 */
export function GET() {
  return NextResponse.json({
    status: "ok",
    app: "ocf-fellowship-management-system",
    timestamp: new Date().toISOString(),
  });
}
