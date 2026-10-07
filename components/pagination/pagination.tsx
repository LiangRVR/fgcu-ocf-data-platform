import * as React from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils/cn";

export interface PaginationProps {
  page: number;
  pageSize: number;
  totalCount: number;
  totalPages: number;
  onPageChange?: (page: number) => void;
  getPageHref?: (page: number) => string;
  onPageSizeChange?: (pageSize: number) => void;
  getPageSizeHref?: (pageSize: number) => string;
  className?: string;
}

function PaginationAction({
  label,
  disabled,
  href,
  onClick,
}: {
  label: string;
  disabled: boolean;
  href?: string;
  onClick?: () => void;
}) {
  const className = "h-9 px-3";
  if (href) {
    return (
      <Button asChild variant="outline" size="sm" className={className}>
        <a href={href} aria-label={label} aria-disabled={disabled || undefined} tabIndex={disabled ? -1 : undefined}>
          {label}
        </a>
      </Button>
    );
  }
  return (
    <Button type="button" variant="outline" size="sm" className={className} onClick={onClick} disabled={disabled} aria-label={label}>
      {label}
    </Button>
  );
}

export function Pagination({
  page,
  pageSize,
  totalCount,
  totalPages,
  onPageChange,
  getPageHref,
  onPageSizeChange,
  getPageSizeHref,
  className,
}: PaginationProps) {
  const safeCount = Math.max(0, totalCount);
  const start = safeCount === 0 ? 0 : (Math.max(1, page) - 1) * pageSize + 1;
  const end = safeCount === 0 ? 0 : Math.min(Math.max(1, page) * pageSize, safeCount);
  const previousDisabled = page <= 1;
  const nextDisabled = page >= totalPages;
  const pageSizeControl = getPageSizeHref ? (
    <label className="flex items-center gap-2 text-sm text-muted-foreground">
      <span>Rows per page</span>
      <select aria-label="Rows per page" value={pageSize} className="h-9 rounded-md border border-input bg-background px-2 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2" onChange={(event) => { window.location.href = getPageSizeHref(Number(event.target.value)); }}>
        {[25, 50, 100].map((size) => <option key={size} value={size}>{size}</option>)}
      </select>
    </label>
  ) : (
    <label className="flex items-center gap-2 text-sm text-muted-foreground">
      <span>Rows per page</span>
      <select aria-label="Rows per page" value={pageSize} className="h-9 rounded-md border border-input bg-background px-2 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2" onChange={(event) => onPageSizeChange?.(Number(event.target.value))}>
        {[25, 50, 100].map((size) => <option key={size} value={size}>{size}</option>)}
      </select>
    </label>
  );

  return (
    <nav aria-label="Pagination" className={cn("flex min-w-0 flex-wrap items-center justify-between gap-x-6 gap-y-3 border-t border-border/70 py-4", className)}>
      <p className="text-sm text-muted-foreground" aria-live="polite">Showing {start}–{end} of {safeCount}</p>
      <div className="flex min-w-0 flex-wrap items-center gap-4">
        {pageSizeControl}
        <div className="flex items-center gap-3">
          <PaginationAction label="Previous" disabled={previousDisabled} href={getPageHref?.(page - 1)} onClick={() => onPageChange?.(page - 1)} />
          <span className="whitespace-nowrap text-sm text-muted-foreground" aria-current="page">Page {page} of {totalPages}</span>
          <PaginationAction label="Next" disabled={nextDisabled} href={getPageHref?.(page + 1)} onClick={() => onPageChange?.(page + 1)} />
        </div>
      </div>
    </nav>
  );
}
