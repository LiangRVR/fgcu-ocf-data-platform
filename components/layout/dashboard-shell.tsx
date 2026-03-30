"use client";

import { useState, type ReactNode } from "react";
import { Sidebar } from "@/components/layout/sidebar";
import { TopBar } from "@/components/layout/top-bar";
import type { Advisor } from "@/lib/auth/session";

interface DashboardShellProps {
  children: ReactNode;
  advisor: Advisor;
}

/**
 * Client-side shell that owns the mobile sidebar open/close state.
 * Wrap all dashboard pages with this via the (dashboard) group layout.
 */
export function DashboardShell({ children, advisor }: DashboardShellProps) {
  const [sidebarOpen, setSidebarOpen] = useState(false);

  return (
    <div className="min-h-screen app-shell-surface text-foreground">
      <Sidebar
        isOpen={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
      />

      {/* Main content — offset by sidebar width on desktop */}
      <div className="lg:pl-72">
        <TopBar
          advisorEmail={advisor.email}
          advisorName={advisor.advisor_name}
          onMenuClick={() => setSidebarOpen(true)}
        />
        <main className="mx-auto min-w-0 max-w-7xl px-4 py-8 sm:px-6 sm:py-10 lg:px-10 lg:py-12 xl:px-12">
          {children}
        </main>
      </div>
    </div>
  );
}
