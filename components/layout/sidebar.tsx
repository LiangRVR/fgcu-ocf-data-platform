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

  const navGroups = [
    {
      title: "Overview",
      items: NAV_ITEMS.filter((item) => ["/dashboard", "/reports"].includes(item.href)),
    },
    {
      title: "People",
      items: NAV_ITEMS.filter((item) => ["/dashboard/account", "/students", "/advising"].includes(item.href)),
    },
    {
      title: "Programs",
      items: NAV_ITEMS.filter((item) => ["/fellowships", "/applications", "/fellowship-thursday", "/scholarship-history"].includes(item.href)),
    },
  ];

  const sidebarContent = (
    <div className="flex h-full flex-col border-r border-white/6 bg-sidebar text-sidebar-foreground shadow-[18px_0_40px_-34px_rgba(15,23,42,0.55)]">
      {/* Brand */}
      <div className="border-b border-white/8 px-6 py-5">
        <div className="flex items-center gap-3">
          <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-[#006747] shadow-[0_12px_24px_-18px_rgba(0,103,71,0.95)]">
          <GraduationCap className="h-5 w-5 text-white" />
        </div>
          <div>
            <p className="text-[10px] font-bold uppercase tracking-[0.22em] text-emerald-300/90">FGCU OCF</p>
            <span className="block text-sm font-semibold leading-tight text-white">
              Fellowship Management
            </span>
          </div>
        </div>
      </div>

      {/* Nav */}
      <nav className="flex-1 space-y-6 overflow-y-auto px-4 py-5">
        {navGroups.map((group) => (
          <div key={group.title} className="space-y-1.5">
            <p className="px-3 text-[10px] font-semibold uppercase tracking-[0.22em] text-slate-500">
              {group.title}
            </p>
            {group.items.map((item) => {
              const Icon = item.icon;
              const isActive =
                item.href === "/dashboard"
                  ? pathname === item.href
                  : pathname === item.href || pathname.startsWith(item.href + "/");

              return (
                <Link
                  key={item.href}
                  href={item.href}
                  onClick={onClose}
                  className={cn(
                    "group flex items-center gap-3 rounded-2xl px-3.5 py-2.5 text-sm font-medium motion-safe:transition-all motion-safe:duration-200",
                    isActive
                      ? "bg-sidebar-accent text-white shadow-[0_16px_24px_-18px_rgba(0,103,71,0.9)]"
                      : "text-slate-300 hover:bg-sidebar-muted hover:text-white"
                  )}
                >
                  {Icon && (
                    <span className={cn(
                      "flex h-8 w-8 items-center justify-center rounded-xl motion-safe:transition-colors",
                      isActive ? "bg-white/10" : "bg-white/[0.03] group-hover:bg-white/[0.06]"
                    )}>
                      <Icon className="h-4.5 w-4.5 shrink-0" />
                    </span>
                  )}
                  <span className="truncate">{item.label}</span>
                </Link>
              );
            })}
          </div>
        ))}
      </nav>

      {/* Footer */}
      <div className="border-t border-white/8 px-6 py-5">
        <div className="rounded-2xl border border-white/6 bg-white/[0.03] p-3.5">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[#006747] text-white">
            <span className="text-sm font-bold">FGCU</span>
          </div>
            <div className="min-w-0 flex-1">
              <div className="text-xs font-medium text-slate-200">Office of Competitive Fellowships</div>
              <div className="text-xs text-slate-400">Internal workspace • March 2026</div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );

  return (
    <>
      {/* Desktop sidebar — always visible ≥ lg */}
      <aside className="hidden lg:fixed lg:inset-y-0 lg:z-30 lg:flex lg:w-72 lg:flex-col">
        {sidebarContent}
      </aside>

      {/* Mobile overlay */}
      {isOpen && (
        <div className="fixed inset-0 z-40 lg:hidden">
          {/* Backdrop */}
          <div
            className="absolute inset-0 bg-slate-950/65 backdrop-blur-sm"
            onClick={onClose}
            aria-hidden="true"
          />
          {/* Drawer */}
          <aside className="relative flex h-full w-72 flex-col">
            {sidebarContent}
            <button
              type="button"
              onClick={onClose}
              className="absolute right-4 top-4 rounded-xl border border-white/10 bg-white/5 p-1.5 text-white/70 motion-safe:transition-colors hover:text-white lg:hidden"
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
