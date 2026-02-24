import {
  LayoutDashboard,
  Users,
  Award,
  FileText,
  MessageSquare,
  BarChart2,
} from "lucide-react";
import type { NavItem } from "@/types";

/**
 * Primary sidebar navigation items.
 * Icons are typed as lucide-react component references.
 */
export const NAV_ITEMS: NavItem[] = [
  { label: "Dashboard", href: "/dashboard", icon: LayoutDashboard },
  { label: "Students", href: "/students", icon: Users },
  { label: "Fellowships", href: "/fellowships", icon: Award },
  { label: "Applications", href: "/applications", icon: FileText },
  { label: "Advising", href: "/advising", icon: MessageSquare },
  { label: "Reports", href: "/reports", icon: BarChart2 },
];
