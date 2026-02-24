"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { GraduationCap, X } from "lucide-react";
import { cn } from "@/lib/utils/cn";
import { NAV_ITEMS } from "@/lib/config/nav";

interface SidebarProps {
  /** Whether the mobile overlay is open */
  isOpen: boolean;
  onClose: () => void;
}

export function Sidebar({ isOpen, onClose }: SidebarProps) {
  const pathname = usePathname();

  const sidebarContent = (
    <div className="flex h-full flex-col bg-sidebar text-sidebar-foreground">
      {/* Brand */}
      <div className="flex h-16 items-center gap-3 border-b border-white/10 px-5">
        <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-white/10">
          <GraduationCap className="h-5 w-5 text-white" />
        </div>
        <span className="text-sm font-semibold leading-tight text-white">
          OCF Fellowship
          <br />
          Management
        </span>
      </div>

      {/* Nav */}
      <nav className="flex-1 space-y-1 overflow-y-auto px-3 py-4">
        {NAV_ITEMS.map((item) => {
          const Icon = item.icon;
          const isActive =
            pathname === item.href || pathname.startsWith(item.href + "/");

          return (
            <Link
              key={item.href}
              href={item.href}
              onClick={onClose}
              className={cn(
                "flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors",
                isActive
                  ? "bg-white/15 text-white"
                  : "text-white/70 hover:bg-white/10 hover:text-white"
              )}
            >
              {Icon && <Icon className="h-4 w-4 shrink-0" />}
              {item.label}
            </Link>
          );
        })}
      </nav>

      {/* Footer */}
      <div className="border-t border-white/10 px-5 py-4">
        <p className="text-xs text-white/40">
          FGCU Office of Competitive Fellowships
        </p>
      </div>
    </div>
  );

  return (
    <>
      {/* Desktop sidebar — always visible ≥ lg */}
      <aside className="hidden lg:fixed lg:inset-y-0 lg:z-30 lg:flex lg:w-64 lg:flex-col">
        {sidebarContent}
      </aside>

      {/* Mobile overlay */}
      {isOpen && (
        <div className="fixed inset-0 z-40 lg:hidden">
          {/* Backdrop */}
          <div
            className="absolute inset-0 bg-black/50"
            onClick={onClose}
            aria-hidden="true"
          />
          {/* Drawer */}
          <aside className="relative flex h-full w-64 flex-col">
            {sidebarContent}
            <button
              type="button"
              onClick={onClose}
              className="absolute right-3 top-3 rounded-md p-1 text-white/70 hover:text-white lg:hidden"
              aria-label="Close sidebar"
            >
              <X className="h-5 w-5" />
            </button>
          </aside>
        </div>
      )}
    </>
  );
}
