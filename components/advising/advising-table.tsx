"use client";

import { Fragment, useState, useMemo, useEffect } from "react";
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
import { Search, CalendarPlus, Calendar, SlidersHorizontal, FilePenLine } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { supabaseBrowserClient } from "@/lib/supabase/client";
import type { Database } from "@/types/database";
import { formatApplicationLabel } from "@/lib/applications/pipeline";

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

type StudentRow = Pick<
  Database["public"]["Tables"]["student"]["Row"],
  "student_id" | "full_name"
>;

type AdvisorRow = Pick<
  Database["public"]["Tables"]["advisor"]["Row"],
  "advisor_id" | "advisor_name"
>;

type ApplicationOption = {
  application_id: number;
  student_id: number;
  application_year: number | null;
  fellowship: { fellowship_name: string } | null;
};

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
  students: StudentRow[];
  advisors: AdvisorRow[];
  applications: ApplicationOption[];
  currentAdvisorId: number;
  defaultStudentId?: string;
  defaultAdvisorId?: string;
  autoOpenAdd?: boolean;
  initialNoShowFilter?: string;
}

const GENERAL_ADVISING_VALUE = "general";

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

const EMPTY_CORRECTION_FORM = { reason: "", details: "" };

export function AdvisingTable({
  initialMeetings,
  students,
  advisors,
  applications,
  currentAdvisorId,
  defaultStudentId,
  defaultAdvisorId,
  autoOpenAdd,
  initialNoShowFilter,
}: AdvisingTableProps) {
  const router = useRouter();
  const [meetings, setMeetings] = useState<AdvisingMeeting[]>(initialMeetings);
  const [searchQuery, setSearchQuery] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [modeFilter, setModeFilter] = useState<string>("all");
  const [noShowFilter, setNoShowFilter] = useState<string>(initialNoShowFilter ?? "all");

  const [addOpen, setAddOpen] = useState(false);

  const [form, setForm] = useState(EMPTY_FORM);
  const [formErrors, setFormErrors] = useState<Record<string, string>>({});
  const [isLoading, setIsLoading] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [correctionMeeting, setCorrectionMeeting] = useState<AdvisingMeeting | null>(null);
  const [correctionForm, setCorrectionForm] = useState(EMPTY_CORRECTION_FORM);
  const [correctionErrors, setCorrectionErrors] = useState<Record<string, string>>({});
  const [isCorrectionLoading, setIsCorrectionLoading] = useState(false);

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

  // Debounce search
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(searchQuery), 300);
    return () => clearTimeout(timer);
  }, [searchQuery]);

  const filteredMeetings = useMemo(() => {
    let list = meetings;

    if (debouncedSearch) {
      const q = debouncedSearch.toLowerCase();
      list = list.filter(
        (m) =>
          (m.student?.full_name ?? "").toLowerCase().includes(q) ||
          (m.advisor?.advisor_name ?? "").toLowerCase().includes(q) ||
          (m.notes ?? "").toLowerCase().includes(q) ||
          m.meeting_mode.toLowerCase().includes(q) ||
          (m.application_id == null
            ? "general advising"
            : formatApplicationLabel(
                m.application?.fellowship?.fellowship_name,
                m.application?.application_year
              )
          ).toLowerCase().includes(q)
      );
    }

    if (modeFilter !== "all") {
      list = list.filter((m) => m.meeting_mode === modeFilter);
    }

    if (noShowFilter === "yes") {
      list = list.filter((m) => m.no_show);
    } else if (noShowFilter === "no") {
      list = list.filter((m) => !m.no_show);
    }

    return list;
  }, [meetings, debouncedSearch, modeFilter, noShowFilter]);

  const validateForm = (f: typeof form): Record<string, string> => {
    const errors: Record<string, string> = {};
    if (!f.student_id) errors.student_id = "Student is required.";
    if (!f.meeting_date) errors.meeting_date = "Meeting date is required.";
    if (!f.meeting_mode) errors.meeting_mode = "Meeting mode is required.";

    if (f.student_id && f.application_id !== GENERAL_ADVISING_VALUE) {
      const allowed = applications
        .filter((a) => String(a.student_id) === f.student_id)
        .map((a) => String(a.application_id));
      if (!allowed.includes(f.application_id)) {
        errors.application_id = "Selected application is not valid for this student.";
      }
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
      const { data, error } = await supabaseBrowserClient
        .from("advising_meeting")
        .insert({
          student_id: Number(form.student_id),
          advisor_id: form.advisor_id ? Number(form.advisor_id) : null,
          application_id: applicationId,
          meeting_date: form.meeting_date,
          meeting_mode: form.meeting_mode,
          no_show: form.no_show,
          notes: form.notes || null,
        } as Database["public"]["Tables"]["advising_meeting"]["Insert"])
        .select(`*, student(full_name), advisor!advising_meeting_advisor_id_fkey(advisor_name), recorded_by:advisor!advising_meeting_created_by_advisor_id_fkey(advisor_name), application!advising_meeting_application_id_fkey(application_id, application_year, fellowship_id, fellowship(fellowship_name))`)
        .single();

      if (error) throw error;

      setMeetings((prev) => [data as AdvisingMeeting, ...prev]);
      toast.success("Meeting recorded successfully.");
      setAddOpen(false);
      setForm({ ...EMPTY_FORM, advisor_id: String(currentAdvisorId) });
      setFormErrors({});
    } catch (err) {
      console.error(err);
      if (isApplicationForeignKeyViolation(err)) {
        toast.error("Selected application is no longer valid for this student. Reset to General Advising.");
        setForm((prev) => ({ ...prev, application_id: GENERAL_ADVISING_VALUE }));
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

  const openCorrection = (meeting: AdvisingMeeting) => {
    setCorrectionMeeting(meeting);
    setCorrectionForm(EMPTY_CORRECTION_FORM);
    setCorrectionErrors({});
  };

  const closeCorrection = () => {
    if (isCorrectionLoading) return;
    setCorrectionMeeting(null);
    setCorrectionForm(EMPTY_CORRECTION_FORM);
    setCorrectionErrors({});
  };

  const handleCorrectionSubmit = async () => {
    if (!correctionMeeting) return;
    const errors: Record<string, string> = {};
    if (!correctionForm.reason.trim()) errors.reason = "Reason is required.";
    if (!correctionForm.details.trim()) errors.details = "Details are required.";
    setCorrectionErrors(errors);
    if (Object.keys(errors).length) return;

    setIsCorrectionLoading(true);
    try {
      const { data, error } = await supabaseBrowserClient
        .from("advising_meeting_amendment")
        .insert({
          meeting_id: correctionMeeting.meeting_id,
          reason: correctionForm.reason.trim(),
          details: correctionForm.details.trim(),
        } as Database["public"]["Tables"]["advising_meeting_amendment"]["Insert"])
        .select("amendment_id, meeting_id, reason, details, created_at, created_by_advisor_id, created_by:advisor!advising_meeting_amendment_created_by_advisor_id_fkey(advisor_name)")
        .single();
      if (error) throw error;

      const amendment = data as AdvisingAmendment;
      setMeetings((previous) => previous.map((meeting) =>
        meeting.meeting_id !== correctionMeeting.meeting_id
          ? meeting
          : {
              ...meeting,
              amendments: [...(meeting.amendments ?? []), amendment].sort((a, b) =>
                a.created_at.localeCompare(b.created_at) || a.amendment_id - b.amendment_id
              ),
            }
      ));
      toast.success("Correction added to the meeting history.");
      setCorrectionMeeting(null);
      setCorrectionForm(EMPTY_CORRECTION_FORM);
      setCorrectionErrors({});
    } catch (err) {
      console.error(err);
      toast.error("Failed to add correction.");
    } finally {
      setIsCorrectionLoading(false);
    }
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
              <Select value={modeFilter} onValueChange={setModeFilter}>
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
              <Select value={noShowFilter} onValueChange={setNoShowFilter}>
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
                        <div className="mt-0.5 text-sm text-slate-500">
                          {new Date(meeting.meeting_date + "T00:00:00").toLocaleDateString(
                            "en-US",
                            { year: "numeric", month: "short", day: "numeric" }
                          )}
                          {meeting.advisor_id && (
                            <span className="ml-1.5 text-slate-400">
                              &middot;{" "}
                              <Link
                                href={`/advisors/${meeting.advisor_id}`}
                                className="hover:text-[#006747] hover:underline"
                              >
                                {meeting.advisor?.advisor_name ?? "—"}
                              </Link>
                            </span>
                          )}
                        </div>
                        {meeting.notes && (
                          <div className="mt-0.5 truncate text-xs text-slate-400 max-w-xs">
                            {meeting.notes}
                          </div>
                        )}
                        <div className="mt-2 flex flex-wrap items-center gap-1.5">
                          <MetricBadge tone={meeting.meeting_mode === "Virtual" ? "blue" : "slate"}>
                            {meeting.meeting_mode}
                          </MetricBadge>
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
                        <Button variant="outline" size="sm" className="mt-3 h-8 text-xs" onClick={() => openCorrection(meeting)}>
                          <FilePenLine className="mr-1.5 h-3.5 w-3.5" />
                          Add Correction
                        </Button>
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
                      Context
                    </th>
                    <th className="hidden px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-gray-500 sm:px-6 sm:py-3 md:table-cell">
                      Advisor
                    </th>
                    <th className="px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-gray-500 sm:px-6 sm:py-3">
                      Date
                    </th>
                    <th className="hidden px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-gray-500 sm:px-6 sm:py-3 sm:table-cell">
                      Mode
                    </th>
                    <th className="px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-gray-500 sm:px-6 sm:py-3">
                      No-Show
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
                        <Button variant="outline" size="sm" className="h-8 text-xs" onClick={() => openCorrection(meeting)}>
                          Add Correction
                        </Button>
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

      {/* Record count */}
      {filteredMeetings.length > 0 && (
        <div className="mt-4 text-sm text-slate-500">
          Showing <span className="font-medium">{filteredMeetings.length}</span>{" "}
          of <span className="font-medium">{meetings.length}</span> meetings
        </div>
      )}

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
            students={students}
            advisors={advisors}
            applications={applications}
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

      <Dialog open={correctionMeeting !== null} onOpenChange={(open) => !open && closeCorrection()}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Add Correction</DialogTitle>
            <DialogDescription>
              Add an attached historical correction. The original meeting remains unchanged.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-2">
            <div className="grid gap-1.5">
              <Label htmlFor="correction_reason">Reason <span className="text-red-500">*</span></Label>
              <Input id="correction_reason" value={correctionForm.reason} onChange={(event) => setCorrectionForm((form) => ({ ...form, reason: event.target.value }))} />
              {correctionErrors.reason ? <p className="text-xs text-red-500">{correctionErrors.reason}</p> : null}
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="correction_details">Details <span className="text-red-500">*</span></Label>
              <textarea id="correction_details" rows={4} value={correctionForm.details} onChange={(event) => setCorrectionForm((form) => ({ ...form, details: event.target.value }))} className="flex min-h-24 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2" />
              {correctionErrors.details ? <p className="text-xs text-red-500">{correctionErrors.details}</p> : null}
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={closeCorrection} disabled={isCorrectionLoading}>Cancel</Button>
            <Button onClick={handleCorrectionSubmit} disabled={isCorrectionLoading} className="bg-[#006747] hover:bg-[#00563b]">{isCorrectionLoading ? "Saving…" : "Add Correction"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

    </>
  );
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
  students: StudentRow[];
  advisors: AdvisorRow[];
  applications: ApplicationOption[];
}

function MeetingForm({ form, setForm, formErrors, students, advisors, applications }: MeetingFormProps) {
  return (
    <div className="grid gap-4 py-2">
      {/* Student */}
      <div className="grid gap-1.5">
        <Label htmlFor="student_id">
          Student <span className="text-red-500">*</span>
        </Label>
        <Select
          value={form.student_id}
          onValueChange={(v) =>
            setForm((prev) => ({
              ...prev,
              student_id: v,
              application_id: GENERAL_ADVISING_VALUE,
            }))
          }
        >
          <SelectTrigger id="student_id" className={formErrors.student_id ? "border-red-500" : ""}>
            <SelectValue placeholder="Select a student…" />
          </SelectTrigger>
          <SelectContent>
            {students.map((s) => (
              <SelectItem key={s.student_id} value={String(s.student_id)}>
                {s.full_name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
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
        <Label htmlFor="advisor_id">Advisor</Label>
        <Select
          value={form.advisor_id || "none"}
          onValueChange={(v) => setForm((prev) => ({ ...prev, advisor_id: v === "none" ? "" : v }))}
        >
          <SelectTrigger id="advisor_id">
            <SelectValue placeholder="Select an advisor (optional)…" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="none">— None —</SelectItem>
            {advisors.map((a) => (
              <SelectItem key={a.advisor_id} value={String(a.advisor_id)}>
                {a.advisor_name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
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
