"use client";

import { Menu, Bell, User } from "lucide-react";
import { Button } from "@/components/ui/button";

interface TopBarProps {
  onMenuClick: () => void;
}

export function TopBar({ onMenuClick }: TopBarProps) {
  return (
    <header className="sticky top-0 z-20 flex h-16 items-center border-b border-border bg-background px-4 lg:px-6">
      {/* Mobile menu button — hidden on desktop */}
      <Button
        variant="ghost"
        size="icon"
        onClick={onMenuClick}
        className="mr-3 lg:hidden"
        aria-label="Open sidebar"
      >
        <Menu className="h-5 w-5" />
      </Button>

      {/* App name — shown on mobile since sidebar is hidden */}
      <span className="font-semibold text-foreground lg:hidden">
        OCF Fellowship Management
      </span>

      {/* Spacer */}
      <div className="flex-1" />

      {/* Right-side actions */}
      <div className="flex items-center gap-2">
        <Button variant="ghost" size="icon" aria-label="Notifications">
          <Bell className="h-5 w-5 text-muted-foreground" />
        </Button>
        <Button variant="ghost" size="icon" aria-label="User menu">
          <User className="h-5 w-5 text-muted-foreground" />
        </Button>
      </div>
    </header>
  );
}
