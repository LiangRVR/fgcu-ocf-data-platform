"use client";

import Link from "next/link";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Bell, LogOut, Menu, Settings, User } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

interface TopBarProps {
  onMenuClick: () => void;
  advisorName: string;
  advisorEmail: string | null;
}

function getInitials(name: string) {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");
}

export function TopBar({ onMenuClick, advisorName, advisorEmail }: TopBarProps) {
  const router = useRouter();
  const [isSigningOut, setIsSigningOut] = useState(false);

  async function handleSignOut() {
    setIsSigningOut(true);

    try {
      const response = await fetch("/api/auth/sign-out", {
        method: "POST",
      });

      if (!response.ok) {
        throw new Error("Sign-out failed");
      }

      router.replace("/login");
      router.refresh();
    } catch (error) {
      console.error(error);
    } finally {
      setIsSigningOut(false);
    }
  }

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
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" className="h-10 gap-3 px-2" aria-label="User menu">
              <div className="hidden text-right sm:block">
                <div className="text-sm font-medium text-foreground">{advisorName}</div>
                <div className="text-xs text-muted-foreground">{advisorEmail ?? "No email linked"}</div>
              </div>
              <div className="flex h-8 w-8 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary">
                {getInitials(advisorName) || <User className="h-4 w-4" />}
              </div>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-64">
            <DropdownMenuLabel className="flex flex-col gap-0.5">
              <span>{advisorName}</span>
              <span className="text-xs font-normal text-muted-foreground">
                {advisorEmail ?? "No email linked"}
              </span>
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem asChild>
              <Link href="/dashboard/account">
                <Settings className="h-4 w-4" />
                Account settings
              </Link>
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={handleSignOut} disabled={isSigningOut}>
              <LogOut className="h-4 w-4" />
              {isSigningOut ? "Signing out..." : "Sign out"}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  );
}
