"use client";

import { useState, useMemo } from "react";
import Link from "next/link";
import { Search, Eye, Award } from "lucide-react";
import { AppCard, AppCardContent } from "@/components/ui/app-card";
import { Button } from "@/components/ui/button";
import { DataToolbar } from "@/components/ui/data-toolbar";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { LifecycleAction } from "@/components/lifecycle";
import { FellowshipEditButton } from "@/components/fellowships/fellowship-edit-button";
import { AddFellowshipButton } from "@/components/fellowships/add-fellowship-button";
import type { Database } from "@/types/database";

type Fellowship = Database["public"]["Tables"]["fellowship"]["Row"];

export interface FellowshipWithMetrics extends Fellowship {
  totalApplications: number;
  finalists: number;
  awardedStudents: number;
}

type FellowshipView = "all" | "archived" | "no-applicants";

interface FellowshipsTableProps {
  initialFellowships: FellowshipWithMetrics[];
  view: FellowshipView;
}

const PAGE_SIZE = 20;

export function FellowshipsTable({ initialFellowships, view }: FellowshipsTableProps) {
  const [fellowships] = useState<FellowshipWithMetrics[]>(initialFellowships);
  const [searchQuery, setSearchQuery] = useState("");
  const [currentPage, setCurrentPage] = useState(1);

  const filteredFellowships = useMemo(() => {
    if (!searchQuery.trim()) return fellowships;
    const q = searchQuery.toLowerCase();
    return fellowships.filter((f) =>
      f.fellowship_name.toLowerCase().includes(q)
    );
  }, [fellowships, searchQuery]);

  const totalPages = Math.ceil(filteredFellowships.length / PAGE_SIZE);
  const paginatedFellowships = useMemo(() => {
    const start = (currentPage - 1) * PAGE_SIZE;
    return filteredFellowships.slice(start, start + PAGE_SIZE);
  }, [filteredFellowships, currentPage]);

  const startIndex = filteredFellowships.length === 0 ? 0 : (currentPage - 1) * PAGE_SIZE + 1;
  const endIndex = Math.min(currentPage * PAGE_SIZE, filteredFellowships.length);

  const handleSearchChange = (value: string) => {
    setSearchQuery(value);
    setCurrentPage(1);
  };

  // The destructive delete control has been replaced by the lifecycle
  // Archive / Restore flow (rendered per-row via LifecycleAction). Archived
  // fellowships remain reachable in the explicit ?view=archived context
  // and can be restored by an administrator; the normal all-fellowships view
  // excludes archived records.
  const isArchiveView = view === "archived";

  return (
    <TooltipProvider>
      <>
        <DataToolbar
          className="mb-4"
          leading={
            <div className="relative w-full sm:max-w-xs">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
              <Input
                placeholder="Search fellowships..."
                className="pl-9"
                value={searchQuery}
                onChange={(e) => handleSearchChange(e.target.value)}
              />
            </div>
          }
        />

        <AppCard>
          <AppCardContent className="p-0">
            {paginatedFellowships.length === 0 ? (
              <EmptyState
                icon={Award}
                title={
                  searchQuery
                    ? "No fellowships match your search"
                    : view === "no-applicants"
                    ? "All fellowships have applicants"
                    : view === "archived"
                    ? "No archived fellowships"
                    : "No fellowships found"
                }
                description={
                  searchQuery
                    ? "Try a different search term."
                    : view === "no-applicants"
                    ? "Every fellowship currently has at least one applicant."
                    : view === "archived"
                    ? "No fellowships are currently archived."
                    : "Get started by adding your first fellowship opportunity."
                }
                action={!searchQuery && view === "all" ? <AddFellowshipButton size="default" /> : undefined}
              />
            ) : (
              <>
                {/* Mobile card list */}
                <div className="md:hidden divide-y divide-gray-200">
                  {paginatedFellowships.map((fellowship) => (
                    <div key={fellowship.fellowship_id} className="p-4">
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <Link
                            href={`/fellowships/${fellowship.fellowship_id}`}
                            className="font-medium text-slate-900 hover:text-[#006747] hover:underline"
                          >
                            {fellowship.fellowship_name}
                          </Link>
                          <div className="mt-1 flex flex-wrap gap-3 text-xs text-slate-500">
                            <span><span className="font-medium text-slate-700">{fellowship.totalApplications}</span> apps</span>
                            <span><span className="font-medium text-slate-700">{fellowship.finalists}</span> finalists</span>
                            <span><span className="font-medium text-slate-700">{fellowship.awardedStudents}</span> awarded</span>
                          </div>
                        </div>
                        <div className="flex shrink-0 items-center gap-1">
                          <Link href={`/fellowships/${fellowship.fellowship_id}`}>
                            <Button variant="ghost" size="icon" className="h-8 w-8 text-slate-600 hover:text-slate-900" title="View fellowship">
                              <Eye className="h-4 w-4" />
                            </Button>
                          </Link>
                          <FellowshipEditButton
                            fellowshipId={fellowship.fellowship_id}
                            fellowshipName={fellowship.fellowship_name}
                          />
                          <LifecycleAction
                            entity="fellowship"
                            entityId={fellowship.fellowship_id}
                            entityLabel={fellowship.fellowship_name}
                            action={isArchiveView ? "restore" : "archive"}
                            variant="ghost"
                            iconOnly
                            stopPropagation={false}
                            className="h-8 w-8 text-amber-700 hover:bg-amber-50 hover:text-amber-800"
                          />
                        </div>
                      </div>
                    </div>
                  ))}
                </div>

                {/* Desktop table */}
                <div className="hidden overflow-x-auto md:block">
                  <table className="w-full">
                    <thead className="bg-gray-50">
                      <tr className="border-b border-gray-200">
                        <th className="px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-gray-500 sm:px-6 sm:py-3">Name</th>
                        <th className="hidden px-3 py-2 text-right text-xs font-medium uppercase tracking-wide text-gray-500 sm:table-cell sm:px-6 sm:py-3">Applications</th>
                        <th className="hidden px-3 py-2 text-right text-xs font-medium uppercase tracking-wide text-gray-500 sm:px-6 sm:py-3 md:table-cell">Finalists</th>
                        <th className="hidden px-3 py-2 text-right text-xs font-medium uppercase tracking-wide text-gray-500 sm:px-6 sm:py-3 md:table-cell">Awarded</th>
                        <th className="px-3 py-2 text-right text-xs font-medium uppercase tracking-wide text-gray-500 sm:px-6 sm:py-3">Actions</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-200 bg-white">
                      {paginatedFellowships.map((fellowship) => (
                        <tr
                          key={fellowship.fellowship_id}
                          className="motion-safe:transition-colors motion-safe:duration-150 hover:bg-gray-50"
                        >
                          <td className="whitespace-nowrap px-3 py-3 sm:px-6 sm:py-4">
                            <Link
                              href={`/fellowships/${fellowship.fellowship_id}`}
                              className="font-medium text-slate-900 hover:text-[#006747] hover:underline"
                            >
                              {fellowship.fellowship_name}
                            </Link>
                          </td>
                          <td className="hidden whitespace-nowrap px-3 py-3 text-right sm:table-cell sm:px-6 sm:py-4">
                            <span className="text-sm font-medium text-slate-700">{fellowship.totalApplications}</span>
                          </td>
                          <td className="hidden whitespace-nowrap px-3 py-3 text-right sm:px-6 sm:py-4 md:table-cell">
                            <span className="text-sm font-medium text-slate-700">{fellowship.finalists}</span>
                          </td>
                          <td className="hidden whitespace-nowrap px-3 py-3 text-right sm:px-6 sm:py-4 md:table-cell">
                            <span className="text-sm font-medium text-slate-700">{fellowship.awardedStudents}</span>
                          </td>
                          <td className="whitespace-nowrap px-3 py-3 sm:px-6 sm:py-4">
                            <div className="flex items-center justify-end gap-2">
                              <Link href={`/fellowships/${fellowship.fellowship_id}`}>
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  className="h-8 w-8 text-slate-600 hover:text-slate-900"
                                  title="View fellowship"
                                >
                                  <Eye className="h-4 w-4" />
                                </Button>
                              </Link>
                              <FellowshipEditButton
                                fellowshipId={fellowship.fellowship_id}
                                fellowshipName={fellowship.fellowship_name}
                              />
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <LifecycleAction
                                    entity="fellowship"
                                    entityId={fellowship.fellowship_id}
                                    entityLabel={fellowship.fellowship_name}
                                    action={isArchiveView ? "restore" : "archive"}
                                    variant="ghost"
                                    iconOnly
                                    stopPropagation={false}
                                    className="h-8 w-8 text-amber-700 hover:bg-amber-50 hover:text-amber-800"
                                  />
                                </TooltipTrigger>
                                <TooltipContent>
                                  <p>
                                    {isArchiveView
                                      ? "Restore fellowship"
                                      : "Archive fellowship"}
                                  </p>
                                </TooltipContent>
                              </Tooltip>
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </AppCardContent>
        </AppCard>

        {/* Pagination */}
        {filteredFellowships.length > 0 && (
          <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="text-sm text-slate-500">
              Showing <span className="font-medium">{startIndex}</span>–<span className="font-medium">{endIndex}</span> of{" "}
              <span className="font-medium">{filteredFellowships.length}</span> fellowships
            </div>
            <div className="flex gap-2 self-start sm:self-auto">
              <Button
                variant="outline"
                size="sm"
                disabled={currentPage <= 1}
                onClick={() => setCurrentPage((p) => p - 1)}
              >
                Previous
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={currentPage >= totalPages}
                onClick={() => setCurrentPage((p) => p + 1)}
              >
                Next
              </Button>
            </div>
          </div>
        )}

        {/* The destructive delete dialog has been removed: lifecycle is
            handled by the per-row LifecycleAction (Archive Fellowship /
            Restore Fellowship). Archived fellowships remain reachable in
            the explicit ?view=archived context and can be restored by an
            administrator. */}
      </>
    </TooltipProvider>
  );
}