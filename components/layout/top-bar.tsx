"use client";

import Link from "next/link";
import { useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { Bell, LogOut, Menu, Settings, User } from "lucide-react";
import { Button } from "@/components/ui/button";
import { NAV_ITEMS } from "@/lib/config/nav";
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
  const pathname = usePathname();
  const [isSigningOut, setIsSigningOut] = useState(false);

  const currentItem = NAV_ITEMS.find((item) =>
    item.href === "/dashboard"
      ? pathname === item.href
      : pathname === item.href || pathname.startsWith(item.href + "/")
  );

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
    <header className="sticky top-0 z-20 border-b border-border/70 bg-background/85 backdrop-blur-xl">
      <div className="mx-auto flex h-16 max-w-7xl items-center gap-3 px-4 sm:px-6 lg:px-10 xl:px-12">
      {/* Mobile menu button — hidden on desktop */}
      <Button
        variant="ghost"
        size="icon"
        onClick={onMenuClick}
        className="motion-safe:transition-colors lg:hidden"
        aria-label="Open sidebar"
      >
        <Menu className="h-5 w-5" />
      </Button>

      <div className="min-w-0 flex-1">
        <p className="hidden text-[10px] font-semibold uppercase tracking-[0.2em] text-slate-400 sm:block">
          OCF Data Platform
        </p>
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-semibold text-slate-900 sm:text-base">
            {currentItem?.label ?? "Workspace"}
          </span>
          <span className="hidden rounded-full border border-emerald-100 bg-emerald-50 px-2 py-0.5 text-[11px] font-medium text-emerald-700 sm:inline-flex">
            Protected workspace
          </span>
        </div>
      </div>

      {/* Right-side actions */}
      <div className="flex items-center gap-2">
        <Button variant="ghost" size="icon" aria-label="Notifications" className="text-slate-500 motion-safe:transition-colors">
          <Bell className="h-5 w-5 text-muted-foreground" />
        </Button>
        <DropdownMenu modal={false}>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" className="h-11 gap-3 rounded-2xl px-2 motion-safe:transition-colors" aria-label="User menu">
              <div className="hidden text-right sm:block">
                <div className="text-sm font-medium text-foreground">{advisorName}</div>
                <div className="text-xs text-muted-foreground">{advisorEmail ?? "No email linked"}</div>
              </div>
              <div className="flex h-9 w-9 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary">
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
      </div>
    </header>
  );
}
