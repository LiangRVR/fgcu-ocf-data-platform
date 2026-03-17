"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { parseISO, isSameMonth } from "date-fns";
import {
  CalendarRange,
  KeyRound,
  Mail,
  Search,
  Shield,
  UserCircle2,
  Users,
} from "lucide-react";
import { toast } from "sonner";
import { useRouter } from "next/navigation";
import { PageHeader } from "@/components/layout/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { Advisor } from "@/lib/auth/session";
import { supabaseBrowserClient } from "@/lib/supabase/client";
import { formatDate } from "@/lib/utils/format";
import {
  passwordUpdateSchema,
  profileUpdateSchema,
} from "@/lib/validators/account";

export interface AccountMeetingRecord {
  meeting_id: number;
  meeting_date: string;
  meeting_mode: string;
  no_show: boolean;
  notes: string | null;
  student_id: number;
  student: {
    student_id: number;
    full_name: string;
    email: string;
    major: string | null;
    class_standing: string | null;
  } | null;
}

export interface AdvisorStudentSummary {
  student_id: number;
  full_name: string;
  email: string;
  major: string | null;
  class_standing: string | null;
  total_meetings: number;
  latest_meeting_date: string;
}

interface AccountPageProps {
  advisor: Advisor;
  initialMeetings: AccountMeetingRecord[];
  initialStudents: AdvisorStudentSummary[];
}

function getNotesPreview(notes: string | null) {
  if (!notes) {
    return "No notes recorded.";
  }

  return notes.length > 90 ? `${notes.slice(0, 90).trim()}...` : notes;
}

export function AccountPage({ advisor, initialMeetings, initialStudents }: AccountPageProps) {
  const router = useRouter();
  const [profileForm, setProfileForm] = useState({
    advisorName: advisor.advisor_name,
    email: advisor.email ?? "",
  });
  const [profileErrors, setProfileErrors] = useState<Record<string, string>>({});
  const [isSavingProfile, setIsSavingProfile] = useState(false);

  const [passwordForm, setPasswordForm] = useState({
    newPassword: "",
    confirmPassword: "",
  });
  const [passwordErrors, setPasswordErrors] = useState<Record<string, string>>({});
  const [isSavingPassword, setIsSavingPassword] = useState(false);

  const [meetingSearch, setMeetingSearch] = useState("");
  const [meetingMode, setMeetingMode] = useState("all");
  const [meetingAttendance, setMeetingAttendance] = useState("all");
  const [meetingStartDate, setMeetingStartDate] = useState("");
  const [meetingEndDate, setMeetingEndDate] = useState("");

  const [studentSearch, setStudentSearch] = useState("");
  const [studentSort, setStudentSort] = useState("recent");

  const filteredMeetings = useMemo(() => {
    return initialMeetings.filter((meeting) => {
      const matchesSearch =
        meetingSearch.trim().length === 0 ||
        (meeting.student?.full_name ?? "").toLowerCase().includes(meetingSearch.toLowerCase());
      const matchesMode = meetingMode === "all" || meeting.meeting_mode === meetingMode;
      const matchesAttendance =
        meetingAttendance === "all" ||
        (meetingAttendance === "no-show" ? meeting.no_show : !meeting.no_show);
      const matchesStartDate = !meetingStartDate || meeting.meeting_date >= meetingStartDate;
      const matchesEndDate = !meetingEndDate || meeting.meeting_date <= meetingEndDate;

      return (
        matchesSearch &&
        matchesMode &&
        matchesAttendance &&
        matchesStartDate &&
        matchesEndDate
      );
    });
  }, [initialMeetings, meetingAttendance, meetingEndDate, meetingMode, meetingSearch, meetingStartDate]);

  const meetingStats = useMemo(() => {
    const uniqueStudents = new Set(filteredMeetings.map((meeting) => meeting.student_id)).size;
    const meetingsThisMonth = filteredMeetings.filter((meeting) =>
      isSameMonth(parseISO(meeting.meeting_date), new Date())
    ).length;
    const noShowCount = filteredMeetings.filter((meeting) => meeting.no_show).length;

    return {
      totalMeetings: filteredMeetings.length,
      meetingsThisMonth,
      uniqueStudents,
      noShowCount,
    };
  }, [filteredMeetings]);

  const filteredStudents = useMemo(() => {
    const search = studentSearch.trim().toLowerCase();
    const visibleStudents = initialStudents.filter((student) => {
      if (!search) {
        return true;
      }

      return (
        student.full_name.toLowerCase().includes(search) ||
        student.email.toLowerCase().includes(search) ||
        (student.major ?? "").toLowerCase().includes(search)
      );
    });

    const sortedStudents = [...visibleStudents];
    sortedStudents.sort((left, right) => {
      if (studentSort === "meetings") {
        return right.total_meetings - left.total_meetings;
      }

      if (studentSort === "name") {
        return left.full_name.localeCompare(right.full_name);
      }

      return right.latest_meeting_date.localeCompare(left.latest_meeting_date);
    });

    return sortedStudents;
  }, [initialStudents, studentSearch, studentSort]);

  async function handleProfileSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const parsed = profileUpdateSchema.safeParse(profileForm);

    if (!parsed.success) {
      const nextErrors = Object.fromEntries(
        parsed.error.issues.map((issue) => [issue.path[0]?.toString() ?? "form", issue.message])
      );
      setProfileErrors(nextErrors);
      return;
    }

    setProfileErrors({});
    setIsSavingProfile(true);

    try {
      const emailChanged = (advisor.email ?? "").toLowerCase() !== parsed.data.email;

      if (emailChanged) {
        const { error } = await supabaseBrowserClient.auth.updateUser({
          email: parsed.data.email,
        });

        if (error) {
          throw new Error(error.message);
        }
      }

      const response = await fetch("/api/account/profile", {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(parsed.data),
      });

      const payload = (await response.json().catch(() => null)) as
        | { error?: string }
        | null;

      if (!response.ok) {
        throw new Error(payload?.error ?? "Unable to update your profile.");
      }

      toast.success("Account updated", {
        description: emailChanged
          ? "Your profile is saved. Check your email inboxes for any confirmation steps."
          : "Your account profile has been updated.",
      });

      router.refresh();
    } catch (error) {
      toast.error("Profile update failed", {
        description: error instanceof Error ? error.message : "Please try again.",
      });
    } finally {
      setIsSavingProfile(false);
    }
  }

  async function handlePasswordSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const parsed = passwordUpdateSchema.safeParse(passwordForm);

    if (!parsed.success) {
      const nextErrors = Object.fromEntries(
        parsed.error.issues.map((issue) => [issue.path[0]?.toString() ?? "form", issue.message])
      );
      setPasswordErrors(nextErrors);
      return;
    }

    setPasswordErrors({});
    setIsSavingPassword(true);

    try {
      const { error } = await supabaseBrowserClient.auth.updateUser({
        password: parsed.data.newPassword,
      });

      if (error) {
        throw new Error(error.message);
      }

      setPasswordForm({ newPassword: "", confirmPassword: "" });
      toast.success("Password updated", {
        description: "Your active session is still valid. Use the new password the next time you sign in.",
      });
    } catch (error) {
      toast.error("Password update failed", {
        description: error instanceof Error ? error.message : "Please try again.",
      });
    } finally {
      setIsSavingPassword(false);
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="My Account"
        description="Manage your advisor profile, security settings, meeting history, and the students you have advised."
      >
        <div className="flex flex-wrap gap-2">
          <Button asChild variant="outline" size="sm">
            <a href="#profile">Profile</a>
          </Button>
          <Button asChild variant="outline" size="sm">
            <a href="#security">Security</a>
          </Button>
          <Button asChild variant="outline" size="sm">
            <a href="#meetings">My meetings</a>
          </Button>
          <Button asChild variant="outline" size="sm">
            <a href="#students">My students</a>
          </Button>
        </div>
      </PageHeader>

      <section id="profile" className="scroll-mt-24 space-y-4">
        <div className="flex items-center gap-2">
          <UserCircle2 className="h-5 w-5 text-[#006747]" />
          <h2 className="text-lg font-semibold text-slate-900">Profile</h2>
        </div>

        <div className="grid gap-4 xl:grid-cols-[1.2fr,0.8fr]">
          <Card>
            <CardHeader>
              <CardTitle>Update your profile</CardTitle>
              <CardDescription>
                You can change your display name and email here. Role and active status stay admin-controlled.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <form className="space-y-4" onSubmit={handleProfileSubmit} noValidate>
                <div className="space-y-1.5">
                  <Label htmlFor="advisorName">Advisor name</Label>
                  <Input
                    id="advisorName"
                    value={profileForm.advisorName}
                    onChange={(event) =>
                      setProfileForm((current) => ({
                        ...current,
                        advisorName: event.target.value,
                      }))
                    }
                    aria-invalid={!!profileErrors.advisorName}
                  />
                  {profileErrors.advisorName && (
                    <p className="text-xs text-destructive">{profileErrors.advisorName}</p>
                  )}
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="email">Email address</Label>
                  <div className="relative">
                    <Mail className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                    <Input
                      id="email"
                      type="email"
                      className="pl-9"
                      value={profileForm.email}
                      onChange={(event) =>
                        setProfileForm((current) => ({
                          ...current,
                          email: event.target.value,
                        }))
                      }
                      aria-invalid={!!profileErrors.email}
                    />
                  </div>
                  {profileErrors.email && (
                    <p className="text-xs text-destructive">{profileErrors.email}</p>
                  )}
                  <p className="text-xs text-muted-foreground">
                    Changing your email may require confirmation in both your current and new inboxes, depending on Supabase settings.
                  </p>
                </div>

                <Button type="submit" disabled={isSavingProfile}>
                  {isSavingProfile ? "Saving profile..." : "Save profile"}
                </Button>
              </form>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Account summary</CardTitle>
              <CardDescription>
                These fields define your current advisor identity in the platform.
              </CardDescription>
            </CardHeader>
            <CardContent className="grid gap-4 sm:grid-cols-2 xl:grid-cols-1">
              <div className="rounded-lg border bg-slate-50 p-4">
                <div className="text-xs font-medium uppercase tracking-wide text-slate-500">Role</div>
                <div className="mt-2 flex items-center gap-2">
                  <Badge variant="outline">{advisor.role}</Badge>
                  <span className="text-xs text-muted-foreground">Admin-controlled</span>
                </div>
              </div>
              <div className="rounded-lg border bg-slate-50 p-4">
                <div className="text-xs font-medium uppercase tracking-wide text-slate-500">Status</div>
                <div className="mt-2 flex items-center gap-2">
                  <Badge variant={advisor.is_active ? "default" : "destructive"}>
                    {advisor.is_active ? "Active" : "Inactive"}
                  </Badge>
                  <span className="text-xs text-muted-foreground">Admin-controlled</span>
                </div>
              </div>
              <div className="rounded-lg border bg-slate-50 p-4">
                <div className="text-xs font-medium uppercase tracking-wide text-slate-500">Last login</div>
                <div className="mt-2 text-sm text-slate-900">
                  {advisor.last_login_at ? formatDate(advisor.last_login_at, "MMM d, yyyy h:mm a") : "Not recorded yet"}
                </div>
              </div>
              <div className="rounded-lg border bg-slate-50 p-4">
                <div className="text-xs font-medium uppercase tracking-wide text-slate-500">Profile email</div>
                <div className="mt-2 text-sm text-slate-900">{advisor.email ?? "No email linked"}</div>
              </div>
            </CardContent>
          </Card>
        </div>
      </section>

      <section id="security" className="scroll-mt-24 space-y-4">
        <div className="flex items-center gap-2">
          <Shield className="h-5 w-5 text-[#006747]" />
          <h2 className="text-lg font-semibold text-slate-900">Security</h2>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>Change your password</CardTitle>
            <CardDescription>
              This uses your current signed-in session. Forgot-password recovery stays available from the login page.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form className="grid gap-4 lg:grid-cols-[1fr,1fr,auto] lg:items-end" onSubmit={handlePasswordSubmit} noValidate>
              <div className="space-y-1.5">
                <Label htmlFor="newPassword">New password</Label>
                <Input
                  id="newPassword"
                  type="password"
                  autoComplete="new-password"
                  placeholder="Minimum 10 characters"
                  value={passwordForm.newPassword}
                  onChange={(event) =>
                    setPasswordForm((current) => ({
                      ...current,
                      newPassword: event.target.value,
                    }))
                  }
                  aria-invalid={!!passwordErrors.newPassword}
                />
                {passwordErrors.newPassword && (
                  <p className="text-xs text-destructive">{passwordErrors.newPassword}</p>
                )}
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="confirmPassword">Confirm password</Label>
                <Input
                  id="confirmPassword"
                  type="password"
                  autoComplete="new-password"
                  placeholder="Re-enter your new password"
                  value={passwordForm.confirmPassword}
                  onChange={(event) =>
                    setPasswordForm((current) => ({
                      ...current,
                      confirmPassword: event.target.value,
                    }))
                  }
                  aria-invalid={!!passwordErrors.confirmPassword}
                />
                {passwordErrors.confirmPassword && (
                  <p className="text-xs text-destructive">{passwordErrors.confirmPassword}</p>
                )}
              </div>

              <Button type="submit" disabled={isSavingPassword}>
                <KeyRound className="h-4 w-4" />
                {isSavingPassword ? "Updating..." : "Update password"}
              </Button>
            </form>
            <p className="mt-3 text-xs text-muted-foreground">
              Current-password verification is deferred in this first release. The flow relies on your active session plus password validation.
            </p>
          </CardContent>
        </Card>
      </section>

      <section id="meetings" className="scroll-mt-24 space-y-4">
        <div className="flex items-center gap-2">
          <CalendarRange className="h-5 w-5 text-[#006747]" />
          <h2 className="text-lg font-semibold text-slate-900">My meetings</h2>
        </div>

        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          <Card>
            <CardHeader className="pb-2">
              <CardDescription>Total meetings</CardDescription>
              <CardTitle className="text-3xl">{meetingStats.totalMeetings}</CardTitle>
            </CardHeader>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardDescription>Meetings this month</CardDescription>
              <CardTitle className="text-3xl">{meetingStats.meetingsThisMonth}</CardTitle>
            </CardHeader>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardDescription>Unique students advised</CardDescription>
              <CardTitle className="text-3xl">{meetingStats.uniqueStudents}</CardTitle>
            </CardHeader>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardDescription>No-shows</CardDescription>
              <CardTitle className="text-3xl">{meetingStats.noShowCount}</CardTitle>
            </CardHeader>
          </Card>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>Meeting history</CardTitle>
            <CardDescription>
              Filter your advising sessions by student, date range, meeting mode, or no-show status.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-3 lg:grid-cols-[1.2fr,0.8fr,0.8fr,0.8fr,0.8fr]">
              <div className="space-y-1.5">
                <Label htmlFor="meetingSearch">Search by student</Label>
                <div className="relative">
                  <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                  <Input
                    id="meetingSearch"
                    placeholder="Search student name"
                    className="pl-9"
                    value={meetingSearch}
                    onChange={(event) => setMeetingSearch(event.target.value)}
                  />
                </div>
              </div>

              <div className="space-y-1.5">
                <Label>Meeting mode</Label>
                <Select value={meetingMode} onValueChange={setMeetingMode}>
                  <SelectTrigger>
                    <SelectValue placeholder="All modes" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All modes</SelectItem>
                    <SelectItem value="In-Person">In-Person</SelectItem>
                    <SelectItem value="Virtual">Virtual</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-1.5">
                <Label>No-show filter</Label>
                <Select value={meetingAttendance} onValueChange={setMeetingAttendance}>
                  <SelectTrigger>
                    <SelectValue placeholder="All meetings" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All meetings</SelectItem>
                    <SelectItem value="attended">Attended only</SelectItem>
                    <SelectItem value="no-show">No-shows only</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="meetingStartDate">Start date</Label>
                <Input
                  id="meetingStartDate"
                  type="date"
                  value={meetingStartDate}
                  onChange={(event) => setMeetingStartDate(event.target.value)}
                />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="meetingEndDate">End date</Label>
                <Input
                  id="meetingEndDate"
                  type="date"
                  value={meetingEndDate}
                  onChange={(event) => setMeetingEndDate(event.target.value)}
                />
              </div>
            </div>

            <div className="flex items-center justify-between text-sm text-muted-foreground">
              <span>Showing {filteredMeetings.length} of {initialMeetings.length} meetings</span>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => {
                  setMeetingSearch("");
                  setMeetingMode("all");
                  setMeetingAttendance("all");
                  setMeetingStartDate("");
                  setMeetingEndDate("");
                }}
              >
                Clear filters
              </Button>
            </div>

            <div className="overflow-x-auto rounded-lg border">
              <table className="min-w-full divide-y divide-border text-sm">
                <thead className="bg-slate-50">
                  <tr>
                    <th className="px-4 py-3 text-left font-medium text-slate-600">Student</th>
                    <th className="px-4 py-3 text-left font-medium text-slate-600">Date</th>
                    <th className="px-4 py-3 text-left font-medium text-slate-600">Mode</th>
                    <th className="px-4 py-3 text-left font-medium text-slate-600">Status</th>
                    <th className="px-4 py-3 text-left font-medium text-slate-600">Notes</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border bg-white">
                  {filteredMeetings.length === 0 ? (
                    <tr>
                      <td colSpan={5} className="px-4 py-8 text-center text-muted-foreground">
                        No meetings match the current filters.
                      </td>
                    </tr>
                  ) : (
                    filteredMeetings.map((meeting) => (
                      <tr key={meeting.meeting_id}>
                        <td className="px-4 py-3 align-top">
                          {meeting.student ? (
                            <Link href={`/students/${meeting.student.student_id}`} className="font-medium text-slate-900 hover:text-primary hover:underline">
                              {meeting.student.full_name}
                            </Link>
                          ) : (
                            <span className="text-muted-foreground">Unknown student</span>
                          )}
                        </td>
                        <td className="px-4 py-3 align-top text-slate-700">{formatDate(meeting.meeting_date)}</td>
                        <td className="px-4 py-3 align-top text-slate-700">{meeting.meeting_mode}</td>
                        <td className="px-4 py-3 align-top">
                          <Badge variant={meeting.no_show ? "destructive" : "secondary"}>
                            {meeting.no_show ? "No-show" : "Attended"}
                          </Badge>
                        </td>
                        <td className="px-4 py-3 align-top text-slate-700">{getNotesPreview(meeting.notes)}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      </section>

      <section id="students" className="scroll-mt-24 space-y-4">
        <div className="flex items-center gap-2">
          <Users className="h-5 w-5 text-[#006747]" />
          <h2 className="text-lg font-semibold text-slate-900">My students</h2>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>Students you have advised</CardTitle>
            <CardDescription>
              This is a meeting-derived roster, not an official advisor assignment list.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-3 lg:grid-cols-[1.2fr,0.8fr]">
              <div className="space-y-1.5">
                <Label htmlFor="studentSearch">Search students</Label>
                <div className="relative">
                  <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                  <Input
                    id="studentSearch"
                    placeholder="Search by name, email, or major"
                    className="pl-9"
                    value={studentSearch}
                    onChange={(event) => setStudentSearch(event.target.value)}
                  />
                </div>
              </div>

              <div className="space-y-1.5">
                <Label>Sort roster</Label>
                <Select value={studentSort} onValueChange={setStudentSort}>
                  <SelectTrigger>
                    <SelectValue placeholder="Sort students" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="recent">Most recent meeting</SelectItem>
                    <SelectItem value="meetings">Most meetings</SelectItem>
                    <SelectItem value="name">Student name</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="overflow-x-auto rounded-lg border">
              <table className="min-w-full divide-y divide-border text-sm">
                <thead className="bg-slate-50">
                  <tr>
                    <th className="px-4 py-3 text-left font-medium text-slate-600">Student</th>
                    <th className="px-4 py-3 text-left font-medium text-slate-600">Email</th>
                    <th className="px-4 py-3 text-left font-medium text-slate-600">Major</th>
                    <th className="px-4 py-3 text-left font-medium text-slate-600">Class standing</th>
                    <th className="px-4 py-3 text-left font-medium text-slate-600">Meetings</th>
                    <th className="px-4 py-3 text-left font-medium text-slate-600">Most recent</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border bg-white">
                  {filteredStudents.length === 0 ? (
                    <tr>
                      <td colSpan={6} className="px-4 py-8 text-center text-muted-foreground">
                        No advised students match the current search.
                      </td>
                    </tr>
                  ) : (
                    filteredStudents.map((student) => (
                      <tr key={student.student_id}>
                        <td className="px-4 py-3 align-top">
                          <Link href={`/students/${student.student_id}`} className="font-medium text-slate-900 hover:text-primary hover:underline">
                            {student.full_name}
                          </Link>
                        </td>
                        <td className="px-4 py-3 align-top text-slate-700">{student.email}</td>
                        <td className="px-4 py-3 align-top text-slate-700">{student.major ?? "—"}</td>
                        <td className="px-4 py-3 align-top text-slate-700">{student.class_standing ?? "—"}</td>
                        <td className="px-4 py-3 align-top">
                          <Badge variant="outline">{student.total_meetings}</Badge>
                        </td>
                        <td className="px-4 py-3 align-top text-slate-700">{formatDate(student.latest_meeting_date)}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      </section>
    </div>
  );
}
