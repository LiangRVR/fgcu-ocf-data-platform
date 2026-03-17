import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils/cn";

const appCardVariants = cva(
  "rounded-2xl border motion-safe:transition-all motion-safe:duration-200",
  {
    variants: {
      variant: {
        default: "app-panel",
        soft: "app-panel-soft",
        elevated: "border-border/70 bg-white shadow-[0_20px_44px_-30px_rgba(15,23,42,0.32)]",
        inset: "border-border/70 bg-surface-subtle shadow-none",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
);

export interface AppCardProps
  extends React.ComponentPropsWithoutRef<typeof Card>,
    VariantProps<typeof appCardVariants> {}

export function AppCard({ className, variant, ...props }: AppCardProps) {
  return <Card className={cn(appCardVariants({ variant }), className)} {...props} />;
}

export function AppCardHeader({ className, ...props }: React.ComponentPropsWithoutRef<typeof CardHeader>) {
  return <CardHeader className={cn("gap-1.5 p-5 sm:p-6", className)} {...props} />;
}

export function AppCardTitle({ className, ...props }: React.ComponentPropsWithoutRef<typeof CardTitle>) {
  return <CardTitle className={cn("text-base font-semibold text-slate-900", className)} {...props} />;
}

export function AppCardDescription({ className, ...props }: React.ComponentPropsWithoutRef<typeof CardDescription>) {
  return <CardDescription className={cn("text-sm text-slate-500", className)} {...props} />;
}

export function AppCardContent({ className, ...props }: React.ComponentPropsWithoutRef<typeof CardContent>) {
  return <CardContent className={cn("p-5 pt-0 sm:p-6 sm:pt-0", className)} {...props} />;
}

export function AppCardFooter({ className, ...props }: React.ComponentPropsWithoutRef<typeof CardFooter>) {
  return <CardFooter className={cn("p-5 pt-0 sm:p-6 sm:pt-0", className)} {...props} />;
}
