"use client";

import { Fragment, useState, useEffect } from "react";
import { AppCard, AppCardContent } from "@/components/ui/app-card";
import { Button } from "@/components/ui/button";
import { DataToolbar } from "@/components/ui/data-toolbar";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { MetricBadge } from "@/components/ui/metric-badge";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Search, CalendarPlus, Calendar, SlidersHorizontal } from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Pagination } from "@/components/pagination/pagination";
import { updateListSearchParams } from "@/lib/utils/pagination";
import { toast } from "sonner";
import { supabaseBrowserClient } from "@/lib/supabase/client";
import type { Database } from "@/types/database";
import { formatApplicationLabel } from "@/lib/applications/pipeline";
import { AddCorrection } from "@/components/advising/add-correction";

type AdvisingMeeting = Database["public"]["Tables"]["advising_meeting"]["Row"] & {
  student: { full_name: string } | null;
  advisor: { advisor_name: string } | null;
  recorded_by: { advisor_name: string } | null;
  application_id: number | null;
  application: {
    application_id: number;
    application_year: number | null;
    fellowship_id: number;
    fellowship: { fellowship_name: string } | null;
  } | null;
  amendments: AdvisingAmendment[];
};

type AdvisingAmendment = Database["public"]["Tables"]["advising_meeting_amendment"]["Row"] & {
  created_by: { advisor_name: string } | null;
};

type StudentRow = { student_id: number; full_name: string };
type AdvisorRow = { advisor_id: number; advisor_name: string };
type ApplicationOption = { application_id: number; student_id: number; application_year: number | null; fellowship: { fellowship_name: string } | null };

const MEETING_MODES = ["In-Person", "Virtual"] as const;
type MeetingMode = (typeof MEETING_MODES)[number];

const APPLICATION_FK_CONSTRAINTS = [
  "advising_meeting_application_id_fkey",
  "advising_meeting_application_student_fkey",
];

function isApplicationForeignKeyViolation(err: unknown): boolean {
  if (typeof err !== "object" || err === null || !("code" in err)) return false;
  const e = err as { code: string; message?: string; details?: string };
  if (e.code !== "23503") return false;
  const text = `${e.message ?? ""} ${e.details ?? ""}`;
  return APPLICATION_FK_CONSTRAINTS.some((name) => text.includes(name));
}

interface AdvisingTableProps {
  initialMeetings: AdvisingMeeting[];
  currentAdvisorId: number;
  defaultStudentId?: string;
  defaultAdvisorId?: string;
  autoOpenAdd?: boolean;
  initialNoShowFilter?: string;
  initialModeFilter?: string;
  initialSearchQuery?: string;
  page: number;
  pageSize: number;
  totalCount: number;
  totalPages: number;
}

export const GENERAL_ADVISING_VALUE = "general";

function formatRecordedAt(createdAt: string | null | undefined): string {
  if (!createdAt) return "date unavailable";
  const date = new Date(createdAt);
  if (Number.isNaN(date.getTime())) return "date unavailable";
  return date.toLocaleString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

const EMPTY_FORM = {
  student_id: "",
  advisor_id: "",
  application_id: GENERAL_ADVISING_VALUE,
  meeting_date: "",
  meeting_mode: "In-Person" as MeetingMode,
  no_show: false,
  notes: "",
};

/**
 * Recovery transition for a rejected insert whose application FK no longer
 * resolves (stale application). Recovery has two inseparable halves while the
 * Log Meeting dialog stays open:
 *   1. reset the selection to General Advising, and
 *   2. invalidate the cached option list so the dialog refetches it and drops
 *      the stale option (otherwise the deleted application remains selectable).
 * Returning both keeps the invariant in one pure, unit-testable place; a
 * regression that drops the reload bump fails the focused unit test.
 */
export function recoverStaleApplication(
  form: typeof EMPTY_FORM,
  applicationsReloadKey: number,
): { form: typeof EMPTY_FORM; applicationsReloadKey: number } {
  return {
    form: { ...form, application_id: GENERAL_ADVISING_VALUE },
    applicationsReloadKey: applicationsReloadKey + 1,
  };
}

export function AdvisingTable({
  initialMeetings,
  currentAdvisorId,
  defaultStudentId,
  defaultAdvisorId,
  autoOpenAdd,
  initialNoShowFilter,
  initialModeFilter,
  initialSearchQuery,
  page,
  pageSize,
  totalCount,
  totalPages,
}: AdvisingTableProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  // The server already filtered and paginated: the page of rows is the source
  // of truth. UI controls only commit their state to the canonical URL.
  const meetings = initialMeetings;
  const [searchQuery, setSearchQuery] = useState(initialSearchQuery ?? "");
  const [debouncedSearch, setDebouncedSearch] = useState(initialSearchQuery ?? "");
  const [modeFilter, setModeFilter] = useState<string>(
    initialModeFilter === "In-Person" || initialModeFilter === "Virtual"
      ? initialModeFilter
      : "all",
  );
  const [noShowFilter, setNoShowFilter] = useState<string>(initialNoShowFilter ?? "all");

  const navigate = (mutate: (next: URLSearchParams) => void) => {
    const next = new URLSearchParams(searchParams.toString());
    mutate(next);
    router.push(`/advising?${next.toString()}`);
  };

  const [addOpen, setAddOpen] = useState(false);

  const [form, setForm] = useState(EMPTY_FORM);
  const [formErrors, setFormErrors] = useState<Record<string, string>>({});
  const [isLoading, setIsLoading] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);
  // Bumped on stale-application recovery so the still-open dialog refetches the
  // selected student's application options and drops the stale one.
  const [applicationsReloadKey, setApplicationsReloadKey] = useState(0);

  // Pre-fill and auto-open add dialog when arriving from a contextual link
  useEffect(() => {
    if (autoOpenAdd) {
      setForm((prev) => ({
        ...prev,
        ...(defaultStudentId ? { student_id: defaultStudentId } : {}),
        advisor_id: defaultAdvisorId ?? String(currentAdvisorId),
      }));
      setAddOpen(true);
    }
  }, [autoOpenAdd, currentAdvisorId, defaultAdvisorId, defaultStudentId]);

  // Keep the controls in sync when the URL changes underneath the table (pill
  // bar navigation, back/forward), without clobbering in-flight typing.
  useEffect(() => {
    setSearchQuery(initialSearchQuery ?? "");
    setDebouncedSearch(initialSearchQuery ?? "");
    setModeFilter(
      initialModeFilter === "In-Person" || initialModeFilter === "Virtual"
        ? initialModeFilter
        : "all",
    );
    setNoShowFilter(initialNoShowFilter ?? "all");
  }, [initialSearchQuery, initialModeFilter, initialNoShowFilter]);

  // Debounce search and commit it to canonical URL state. When the committed
  // prop already matches the typed value (initial mount, or the server echo
  // after navigation) nothing is pushed, so loading a filtered/paginated URL
  // never rewrites it and spuriously drops the current page.
  useEffect(() => {
    if (searchQuery === (initialSearchQuery ?? "")) return;
    const timer = setTimeout(() => {
      setDebouncedSearch(searchQuery);
      const next = updateListSearchParams(searchParams.toString(), {
        search: searchQuery || null,
      });
      router.push(`/advising?${next.toString()}`);
    }, 300);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchQuery, initialSearchQuery]);

  // The server performs search/filter/pagination; the returned page is final.
  const filteredMeetings = meetings;

  const validateForm = (f: typeof form): Record<string, string> => {
    const errors: Record<string, string> = {};
    if (!f.student_id) errors.student_id = "Student is required.";
    if (!f.advisor_id) errors.advisor_id = "Advisor is required.";
    if (!f.meeting_date) errors.meeting_date = "Meeting date is required.";
    if (!f.meeting_mode) errors.meeting_mode = "Meeting mode is required.";

    if (f.student_id && f.application_id !== GENERAL_ADVISING_VALUE) {
      if (!/^\d+$/.test(f.application_id)) errors.application_id = "Select an application from the list.";
    }
    return errors;
  };

  const handleAddSubmit = async () => {
    const errors = validateForm(form);
    setFormErrors(errors);
    if (Object.keys(errors).length > 0) return;

    const applicationId =
      form.application_id === GENERAL_ADVISING_VALUE
        ? null
        : Number(form.application_id);

    setIsLoading(true);
    try {
      const { error } = await supabaseBrowserClient
        .from("advising_meeting")
        .insert({
          student_id: Number(form.student_id),
          advisor_id: Number(form.advisor_id),
          application_id: applicationId,
          meeting_date: form.meeting_date,
          meeting_mode: form.meeting_mode,
          no_show: form.no_show,
          notes: form.notes || null,
        } as Database["public"]["Tables"]["advising_meeting"]["Insert"]);

      if (error) throw error;

      // Re-run the server loader so the bounded, paginated list is authoritative.
      toast.success("Meeting recorded successfully.");
      router.refresh();
      setAddOpen(false);
      setForm({ ...EMPTY_FORM, advisor_id: String(currentAdvisorId) });
      setFormErrors({});
    } catch (err) {
      console.error(err);
      if (isApplicationForeignKeyViolation(err)) {
        const recovery = recoverStaleApplication(form, applicationsReloadKey);
        // Functional update keeps any field the user edited while the insert
        // was in flight; only the invalid application selection is replaced.
        setForm((prev) => ({ ...prev, application_id: recovery.form.application_id }));
        setApplicationsReloadKey(recovery.applicationsReloadKey);
        toast.error("Selected application is no longer valid for this student. Reset to General Advising.");
        router.refresh();
      } else {
        toast.error("Failed to create meeting.");
      }
    } finally {
      setIsLoading(false);
    }
  };

  const resetAndCloseAdd = () => {
    setForm({ ...EMPTY_FORM, advisor_id: String(currentAdvisorId) });
    setFormErrors({});
    setAddOpen(false);
  };

  return (
    <>
      {/* Control Bar */}
      <DataToolbar
        className="mb-4"
        leading={
          <>
            <div className="flex items-center gap-2">
              <div className="relative min-w-0 flex-1 sm:w-72 sm:flex-none">
                <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                <Input
                  placeholder="Search by student, advisor, notes…"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="pl-9"
                />
              </div>
              <Button
                variant="outline"
                size="sm"
                className="shrink-0 gap-1.5 xl:hidden"
                onClick={() => setFiltersOpen((o) => !o)}
              >
                <SlidersHorizontal className="h-4 w-4" />
                Filters
                {(modeFilter !== "all" || noShowFilter !== "all") && (
                  <span className="flex h-4 w-4 items-center justify-center rounded-full bg-primary text-[10px] font-bold text-white">
                    •
                  </span>
                )}
              </Button>
            </div>
            <div className={`${filtersOpen ? "flex" : "hidden xl:flex"} flex-wrap gap-3 xl:flex-row xl:items-center`}>
              <Select
                value={modeFilter}
                onValueChange={(value) => {
                  setModeFilter(value);
                  navigate((next) => {
                    if (value === "all") next.delete("mode");
                    else next.set("mode", value);
                    next.set("page", "1");
                  });
                }}
              >
                <SelectTrigger className="w-full sm:w-36">
                  <SelectValue placeholder="All modes" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All modes</SelectItem>
                  {MEETING_MODES.map((m) => (
                    <SelectItem key={m} value={m}>
                      {m}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select
                value={noShowFilter}
                onValueChange={(value) => {
                  setNoShowFilter(value);
                  navigate((next) => {
                    if (value === "all") next.delete("no_show");
                    else next.set("no_show", value);
                    next.set("page", "1");
                  });
                }}
              >
                <SelectTrigger className="w-full sm:w-36">
                  <SelectValue placeholder="All attendance" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All attendance</SelectItem>
                  <SelectItem value="no">Attended</SelectItem>
                  <SelectItem value="yes">No-show</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </>
        }
        trailing={
          <Button
            size="sm"
            onClick={() => {
              setForm({ ...EMPTY_FORM, advisor_id: String(currentAdvisorId) });
              setFormErrors({});
              setAddOpen(true);
            }}
          >
            <CalendarPlus className="mr-2 h-4 w-4" />
            Log Meeting
          </Button>
        }
      />

      {/* Table */}
      <AppCard>
        <AppCardContent className="p-0">
          {filteredMeetings.length === 0 ? (
            <EmptyState
              icon={Calendar}
              title="No meetings found"
              description={
                debouncedSearch || modeFilter !== "all" || noShowFilter !== "all"
                  ? "Try adjusting your search or filters."
                  : "Get started by logging your first advising meeting."
              }
              action={
                !debouncedSearch && modeFilter === "all" && noShowFilter === "all" ? (
                  <Button
                    onClick={() => {
                      setForm({ ...EMPTY_FORM, advisor_id: String(currentAdvisorId) });
                      setFormErrors({});
                      setAddOpen(true);
                    }}
                  >
                    <CalendarPlus className="mr-2 h-4 w-4" />
                    Log Meeting
                  </Button>
                ) : undefined
              }
            />
          ) : (
            <>
              {/* Mobile card list */}
              <div className="md:hidden divide-y divide-gray-200">
                {filteredMeetings.map((meeting) => (
                  <div key={meeting.meeting_id} className="p-4">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <Link
                          href={`/students/${meeting.student_id}`}
                          className="font-medium text-slate-900 hover:text-[#006747] hover:underline"
                        >
                          {meeting.student?.full_name ?? "—"}
                        </Link>
                        <div className="mt-0.5 text-sm text-slate-500">
                          <span className="font-medium text-slate-500">Application/Fellowship: </span>
                          {meeting.application_id == null ? (
                            <span className="text-slate-500">General Advising</span>
                          ) : (
                            <span className="text-slate-600">
                              {formatApplicationLabel(
                                meeting.application?.fellowship?.fellowship_name,
                                meeting.application?.application_year
                              )}
                            </span>
                          )}
                        </div>
                        <div className="mt-1 text-xs text-slate-400">
                          Recorded by {meeting.recorded_by?.advisor_name ?? "Unknown (legacy record)"} · Recorded {formatRecordedAt(meeting.created_at)}
                        </div>
                        <div className="mt-2 grid grid-cols-[auto_1fr] gap-x-2 gap-y-1 text-sm text-slate-600">
                          <span className="text-slate-500">Meeting Date</span>
                          {new Date(meeting.meeting_date + "T00:00:00").toLocaleDateString(
                            "en-US",
                            { year: "numeric", month: "short", day: "numeric" }
                          )}
                          <span className="text-slate-500">Advisor</span>
                          {meeting.advisor_id ? (
                              <Link
                                href={`/advisors/${meeting.advisor_id}`}
                                className="hover:text-[#006747] hover:underline"
                              >
                                {meeting.advisor?.advisor_name ?? "—"}
                              </Link>
                          ) : <span>—</span>}
                        </div>
                        {meeting.notes && (
                          <div className="mt-0.5 truncate text-xs text-slate-400 max-w-xs">
                            {meeting.notes}
                          </div>
                        )}
                        <div className="mt-2 flex flex-wrap items-center gap-1.5">
                          <span className="text-xs text-slate-500">Mode:</span>
                          <MetricBadge tone={meeting.meeting_mode === "Virtual" ? "blue" : "slate"}>
                            {meeting.meeting_mode}
                          </MetricBadge>
                          <span className="ml-1 text-xs text-slate-500">No Show:</span>
                          {meeting.no_show ? (
                            <MetricBadge tone="red">
                              No-show
                            </MetricBadge>
                          ) : (
                            <MetricBadge tone="green">
                              Attended
                            </MetricBadge>
                          )}
                        </div>
                        <div className="mt-3"><AddCorrection meetingId={meeting.meeting_id} onSaved={() => router.refresh()} /></div>
                        <AmendmentHistory amendments={meeting.amendments ?? []} />
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
                    <th className="px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-gray-500 sm:px-6 sm:py-3">
                      Student
                    </th>
                    <th className="hidden px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-gray-500 sm:px-6 sm:py-3 md:table-cell">
                      Application/Fellowship
                    </th>
                    <th className="hidden px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-gray-500 sm:px-6 sm:py-3 md:table-cell">
                      Advisor
                    </th>
                    <th className="px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-gray-500 sm:px-6 sm:py-3">
                      Meeting Date
                    </th>
                    <th className="hidden px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-gray-500 sm:px-6 sm:py-3 sm:table-cell">
                      Mode
                    </th>
                    <th className="px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-gray-500 sm:px-6 sm:py-3">
                      No Show
                    </th>
                    <th className="hidden px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-gray-500 sm:px-6 sm:py-3 lg:table-cell">
                      Notes
                    </th>
                    <th className="px-3 py-2 text-right text-xs font-medium uppercase tracking-wide text-gray-500 sm:px-6 sm:py-3">
                      History
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-200 bg-white">
                  {filteredMeetings.map((meeting) => (
                    <Fragment key={meeting.meeting_id}>
                    <tr className="motion-safe:transition-colors motion-safe:duration-150 hover:bg-gray-50">
                      <td className="whitespace-nowrap px-3 py-3 sm:px-6 sm:py-4">
                        <Link
                          href={`/students/${meeting.student_id}`}
                          className="font-medium text-slate-900 hover:text-[#006747] hover:underline"
                        >
                          {meeting.student?.full_name ?? "—"}
                        </Link>
                      </td>
                      <td className="hidden whitespace-nowrap px-3 py-3 sm:px-6 sm:py-4 md:table-cell">
                        {meeting.application_id == null ? (
                          <span className="text-sm text-slate-500">General Advising</span>
                        ) : (
                          <span className="text-sm text-slate-600">
                            {formatApplicationLabel(
                              meeting.application?.fellowship?.fellowship_name,
                              meeting.application?.application_year
                            )}
                          </span>
                        )}
                      </td>
                      <td className="hidden whitespace-nowrap px-3 py-3 sm:px-6 sm:py-4 md:table-cell">
                        {meeting.advisor_id ? (
                          <Link
                            href={`/advisors/${meeting.advisor_id}`}
                            className="text-sm text-slate-600 hover:text-[#006747] hover:underline"
                          >
                            {meeting.advisor?.advisor_name ?? "—"}
                          </Link>
                        ) : (
                          <span className="text-sm text-slate-400">—</span>
                        )}
                      </td>
                      <td className="whitespace-nowrap px-3 py-3 sm:px-6 sm:py-4">
                        <div className="text-sm text-slate-600">
                          {new Date(meeting.meeting_date + "T00:00:00").toLocaleDateString(
                            "en-US",
                            { year: "numeric", month: "short", day: "numeric" }
                          )}
                        </div>
                        <div className="mt-1 text-xs text-slate-400">
                          Recorded by {meeting.recorded_by?.advisor_name ?? "Unknown (legacy record)"}
                          <span className="block">Recorded {formatRecordedAt(meeting.created_at)}</span>
                        </div>
                      </td>
                      <td className="hidden whitespace-nowrap px-3 py-3 sm:px-6 sm:py-4 sm:table-cell">
                        <MetricBadge tone={meeting.meeting_mode === "Virtual" ? "blue" : "slate"}>
                          {meeting.meeting_mode}
                        </MetricBadge>
                      </td>
                      <td className="whitespace-nowrap px-3 py-3 sm:px-6 sm:py-4">
                        {meeting.no_show ? (
                          <MetricBadge tone="red">
                            Yes
                          </MetricBadge>
                        ) : (
                          <MetricBadge tone="green">
                            Attended
                          </MetricBadge>
                        )}
                      </td>
                      <td className="hidden max-w-xs px-3 py-3 sm:px-6 sm:py-4 lg:table-cell">
                        <div className="truncate text-sm text-slate-500">
                          {meeting.notes ? meeting.notes : <span className="text-slate-300">—</span>}
                        </div>
                      </td>
                      <td className="px-3 py-3 text-right sm:px-6 sm:py-4">
                        <AddCorrection meetingId={meeting.meeting_id} onSaved={() => router.refresh()} />
                      </td>
                    </tr>
                    {meeting.amendments?.length > 0 ? (
                      <tr className="bg-amber-50/40">
                        <td colSpan={8} className="px-3 pb-4 pt-0 sm:px-6">
                          <AmendmentHistory amendments={meeting.amendments} />
                        </td>
                      </tr>
                    ) : null}
                    </Fragment>
                  ))}
                </tbody>
              </table>
              </div>
            </>
          )}
        </AppCardContent>
      </AppCard>

      {/* Pagination summary */}
      <Pagination
        page={page}
        pageSize={pageSize}
        totalCount={totalCount}
        totalPages={totalPages}
        getPageHref={(nextPage) =>
          `/advising?${updateListSearchParams(searchParams.toString(), { page: nextPage }).toString()}`
        }
        getPageSizeHref={(nextPageSize) =>
          `/advising?${updateListSearchParams(searchParams.toString(), { pageSize: nextPageSize }).toString()}`
        }
        className="mt-4"
      />

      {/* ── Add Meeting Dialog ─────────────────────────────── */}
      <Dialog open={addOpen} onOpenChange={(o) => !o && resetAndCloseAdd()}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Log Advising Meeting</DialogTitle>
            <DialogDescription>
              Record a new advising session between a student and advisor.
            </DialogDescription>
          </DialogHeader>

          <MeetingForm
            form={form}
            setForm={setForm}
            formErrors={formErrors}
            applicationsReloadKey={applicationsReloadKey}
          />

          <DialogFooter>
            <Button variant="outline" onClick={resetAndCloseAdd} disabled={isLoading}>
              Cancel
            </Button>
            <Button
              onClick={handleAddSubmit}
              disabled={isLoading}
              className="bg-[#006747] hover:bg-[#00563b]"
            >
              {isLoading ? "Saving…" : "Log Meeting"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

    </>
  );
}

type AdvisingHistoryMeeting = Database["public"]["Tables"]["advising_meeting"]["Row"] & {
  advisor: { advisor_name: string } | null;
  recorded_by: { advisor_name: string } | null;
  application_id: number | null;
  application: AdvisingMeeting["application"];
  amendments: AdvisingAmendment[];
};

export function AdvisingHistory({ meetings, applications, canCorrect = true }: { meetings: AdvisingHistoryMeeting[]; applications: { application_id: number; label: string }[]; canCorrect?: boolean }) {
  const [filter, setFilter] = useState("all");
  const [historyMeetings, setHistoryMeetings] = useState(meetings);
  const visible = historyMeetings.filter((m) => filter === "all" || (filter === "general" ? m.application_id == null : String(m.application_id) === filter));
  return <section className="mb-5 rounded-2xl border border-border/70 bg-white p-4">
    <div className="mb-3 flex flex-wrap items-center gap-2"><h3 className="mr-auto font-semibold text-slate-900">Advising history</h3>
      <select aria-label="Filter advising history" value={filter} onChange={(e) => setFilter(e.target.value)} className="h-10 rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        <option value="all">All</option><option value="general">General Advising</option>{applications.map(a => <option key={a.application_id} value={String(a.application_id)}>{a.label}</option>)}
      </select>
    </div>
    <div className="space-y-3">{visible.map(m => <article key={m.meeting_id} className="rounded-xl border border-slate-200 p-4">
      <div className="flex flex-wrap items-center gap-2"><strong>{new Date(m.meeting_date+"T00:00:00").toLocaleDateString("en-US",{year:"numeric",month:"short",day:"numeric"})}</strong><span className="text-slate-600">{m.advisor?.advisor_name ?? "Advisor unavailable"}</span><MetricBadge tone="slate">{m.application_id == null ? "General Advising" : formatApplicationLabel(m.application?.fellowship?.fellowship_name,m.application?.application_year)}</MetricBadge><MetricBadge tone={m.meeting_mode === "Virtual" ? "blue" : "slate"}>{m.meeting_mode}</MetricBadge><MetricBadge tone={m.no_show ? "red" : "green"}>{m.no_show ? "No-show" : "Attended"}</MetricBadge>{canCorrect && <AddCorrection meetingId={m.meeting_id} onSaved={(amendment) => setHistoryMeetings((previous) => previous.map((item) => item.meeting_id !== m.meeting_id ? item : { ...item, amendments: [...(item.amendments ?? []), amendment].sort((a, b) => a.created_at.localeCompare(b.created_at) || a.amendment_id - b.amendment_id) }))} />}</div>
      <p className="mt-3 whitespace-pre-wrap text-sm text-slate-700">{m.notes || "No notes recorded."}</p><p className="mt-2 text-xs text-slate-400">Recorded by {m.recorded_by?.advisor_name ?? "Unknown (legacy record)"} · {formatRecordedAt(m.created_at)}</p><AmendmentHistory amendments={m.amendments ?? []}/>
    </article>)}{visible.length === 0 && <p className="py-5 text-sm text-slate-500">No advising history for this filter.</p>}</div>
  </section>;
}

function AmendmentHistory({ amendments }: { amendments: AdvisingAmendment[] }) {
  if (!amendments.length) return null;
  return (
    <div className="mt-3 border-l-2 border-amber-300 pl-3">
      <p className="text-xs font-semibold uppercase tracking-wide text-amber-800">Corrections</p>
      <div className="mt-2 space-y-2">
        {amendments.map((amendment) => (
          <div key={amendment.amendment_id} className="rounded-lg border border-amber-200 bg-amber-50/70 p-3 text-sm text-slate-700">
            <p className="font-medium text-slate-900">{amendment.reason}</p>
            <p className="mt-1 whitespace-pre-wrap leading-5">{amendment.details}</p>
            <p className="mt-2 text-xs text-slate-500">Added by {amendment.created_by?.advisor_name ?? "Unknown advisor"} · {formatRecordedAt(amendment.created_at)}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Shared Form Component ──────────────────────────────────────────────────

interface MeetingFormProps {
  form: typeof EMPTY_FORM;
  setForm: React.Dispatch<React.SetStateAction<typeof EMPTY_FORM>>;
  formErrors: Record<string, string>;
  /**
   * Increments on stale-application recovery. Included in the application
   * option refetch deps so the open dialog reloads the selected student's
   * options and removes an option the server no longer returns.
   */
  applicationsReloadKey: number;
}

function MeetingForm({ form, setForm, formErrors, applicationsReloadKey }: MeetingFormProps) {
  const [studentSearch, setStudentSearch] = useState("");
  const [advisorSearch, setAdvisorSearch] = useState("");
  const [students, setStudents] = useState<StudentRow[]>([]);
  const [advisors, setAdvisors] = useState<AdvisorRow[]>([]);
  const [applications, setApplications] = useState<ApplicationOption[]>([]);
  // Derive the visible option lists so a short query hides stale results
  // without a synchronous setState inside an effect.
  const visibleStudents = studentSearch.trim().length < 2 ? [] : students;
  const visibleAdvisors = advisorSearch.trim().length < 2 ? [] : advisors;
  useEffect(() => {
    if (studentSearch.trim().length < 2) return;
    const timer = setTimeout(async () => {
      const { data } = await supabaseBrowserClient.from("student").select("student_id, full_name").is("archived_at", null).ilike("full_name", `%${studentSearch.trim()}%`).order("full_name").limit(20);
      setStudents((data ?? []) as StudentRow[]);
    }, 250);
    return () => clearTimeout(timer);
  }, [studentSearch]);
  useEffect(() => {
    if (advisorSearch.trim().length < 2) return;
    const timer = setTimeout(async () => {
      const { data } = await supabaseBrowserClient.from("advisor").select("advisor_id, advisor_name").eq("is_active", true).ilike("advisor_name", `%${advisorSearch.trim()}%`).order("advisor_name").limit(20);
      setAdvisors((data ?? []) as AdvisorRow[]);
    }, 250);
    return () => clearTimeout(timer);
  }, [advisorSearch]);
  useEffect(() => {
    if (!form.student_id) return;
    let active = true;
    void supabaseBrowserClient.from("application").select("application_id, student_id, application_year, fellowship(fellowship_name)").eq("student_id", Number(form.student_id)).order("application_id", { ascending: false }).limit(50).then(({ data }) => { if (active) setApplications((data ?? []) as unknown as ApplicationOption[]); });
    return () => { active = false; };
  }, [form.student_id, applicationsReloadKey]);
  return (
    <div className="grid gap-4 py-2">
      {/* Student */}
      <div className="grid gap-1.5">
        <Label htmlFor="student_id">
          Student <span className="text-red-500">*</span>
        </Label>
        <Input id="student-search" placeholder="Type at least 2 letters to search…" value={studentSearch} onChange={(e) => setStudentSearch(e.target.value)} />
        <div className="max-h-36 overflow-y-auto">{visibleStudents.map((s) => <button type="button" key={s.student_id} className="block w-full p-2 text-left text-sm hover:bg-slate-50" onClick={() => { setForm((prev) => ({ ...prev, student_id: String(s.student_id), application_id: GENERAL_ADVISING_VALUE })); setStudentSearch(s.full_name); }}>{s.full_name}</button>)}</div>
        {form.student_id && <p className="text-sm text-slate-600">Selected student #{form.student_id}</p>}
        {formErrors.student_id && (
          <p className="text-xs text-red-500">{formErrors.student_id}</p>
        )}
      </div>

      {/* Application (depends on selected student) */}
      <div className="grid gap-1.5">
        <Label htmlFor="application_id">Application</Label>
        <Select
          value={form.application_id}
          onValueChange={(v) => setForm((prev) => ({ ...prev, application_id: v }))}
          disabled={!form.student_id}
        >
          <SelectTrigger
            id="application_id"
            className={formErrors.application_id ? "border-red-500" : ""}
          >
            <SelectValue placeholder="Select a student first…" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={GENERAL_ADVISING_VALUE}>General Advising</SelectItem>
            {applications
              .filter((a) => String(a.student_id) === form.student_id)
              .map((a) => (
                <SelectItem key={a.application_id} value={String(a.application_id)}>
                  {formatApplicationLabel(a.fellowship?.fellowship_name, a.application_year)}
                </SelectItem>
              ))}
          </SelectContent>
        </Select>
        {formErrors.application_id && (
          <p className="text-xs text-red-500">{formErrors.application_id}</p>
        )}
      </div>

      {/* Advisor */}
      <div className="grid gap-1.5">
        <Label htmlFor="advisor_id">Advisor <span className="text-red-500">*</span></Label>
        <Input id="advisor-search" placeholder="Type at least 2 letters to search…" value={advisorSearch} onChange={(e) => setAdvisorSearch(e.target.value)} />
        <div className="max-h-36 overflow-y-auto">{visibleAdvisors.map((a) => <button type="button" key={a.advisor_id} className="block w-full p-2 text-left text-sm hover:bg-slate-50" onClick={() => { setForm((prev) => ({ ...prev, advisor_id: String(a.advisor_id) })); setAdvisorSearch(a.advisor_name); }}>{a.advisor_name}</button>)}</div>
        {form.advisor_id && <p className="text-sm text-slate-600">Selected advisor #{form.advisor_id}</p>}
        {formErrors.advisor_id && <p className="text-xs text-red-500">{formErrors.advisor_id}</p>}
      </div>

      {/* Meeting Date */}
      <div className="grid gap-1.5">
        <Label htmlFor="meeting_date">
          Meeting Date <span className="text-red-500">*</span>
        </Label>
        <Input
          id="meeting_date"
          type="date"
          value={form.meeting_date}
          onChange={(e) => setForm((prev) => ({ ...prev, meeting_date: e.target.value }))}
          className={formErrors.meeting_date ? "border-red-500" : ""}
        />
        {formErrors.meeting_date && (
          <p className="text-xs text-red-500">{formErrors.meeting_date}</p>
        )}
      </div>

      {/* Meeting Mode */}
      <div className="grid gap-1.5">
        <Label htmlFor="meeting_mode">
          Mode <span className="text-red-500">*</span>
        </Label>
        <Select
          value={form.meeting_mode}
          onValueChange={(v) =>
            setForm((prev) => ({ ...prev, meeting_mode: v as MeetingMode }))
          }
        >
          <SelectTrigger id="meeting_mode" className={formErrors.meeting_mode ? "border-red-500" : ""}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {MEETING_MODES.map((m) => (
              <SelectItem key={m} value={m}>
                {m}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {formErrors.meeting_mode && (
          <p className="text-xs text-red-500">{formErrors.meeting_mode}</p>
        )}
      </div>

      {/* No-Show */}
      <div className="flex items-center gap-3">
        <input
          id="no_show"
          type="checkbox"
          checked={form.no_show}
          onChange={(e) => setForm((prev) => ({ ...prev, no_show: e.target.checked }))}
          className="h-4 w-4 rounded border-gray-300 accent-[#006747]"
        />
        <Label htmlFor="no_show" className="cursor-pointer font-normal">
          Student was a no-show
        </Label>
      </div>

      {/* Notes */}
      <div className="grid gap-1.5">
        <Label htmlFor="notes">Notes</Label>
        <textarea
          id="notes"
          rows={3}
          value={form.notes}
          onChange={(e) => setForm((prev) => ({ ...prev, notes: e.target.value }))}
          placeholder="Optional notes about the meeting…"
          className="flex min-h-20 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
        />
      </div>
    </div>
  );
}
