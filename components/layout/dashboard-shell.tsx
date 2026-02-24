"use client";

import { useState, type ReactNode } from "react";
import { Sidebar } from "@/components/layout/sidebar";
import { TopBar } from "@/components/layout/top-bar";

interface DashboardShellProps {
  children: ReactNode;
}

/**
 * Client-side shell that owns the mobile sidebar open/close state.
 * Wrap all dashboard pages with this via the (dashboard) group layout.
 */
export function DashboardShell({ children }: DashboardShellProps) {
  const [sidebarOpen, setSidebarOpen] = useState(false);

  return (
    <div className="min-h-screen bg-background">
      <Sidebar
        isOpen={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
      />

      {/* Main content — offset by sidebar width on desktop */}
      <div className="lg:pl-64">
        <TopBar onMenuClick={() => setSidebarOpen(true)} />
        <main className="mx-auto max-w-7xl px-4 py-6 lg:px-6">
          {children}
        </main>
      </div>
    </div>
  );
}
