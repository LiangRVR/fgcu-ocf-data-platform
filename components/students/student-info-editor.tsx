"use client";

import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Mail, GraduationCap, Pencil, X, Check } from "lucide-react";
import { toast } from "sonner";
import { supabaseBrowserClient } from "@/lib/supabase/client";
import type { Database } from "@/types/database";

type Student = Database["public"]["Tables"]["student"]["Row"];

interface StudentInfoEditorProps {
  initialStudent: Student;
}

// ─── tiny helpers ────────────────────────────────────────────────────────────

function SectionEditButton({ onClick }: { onClick: () => void }) {
  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={onClick}
      className="h-8 gap-1.5 text-slate-500 hover:text-slate-900"
    >
      <Pencil className="h-3.5 w-3.5" />
      Edit
    </Button>
  );
}

function SectionSaveRow({
  onSave,
  onCancel,
  saving,
}: {
  onSave: () => void;
  onCancel: () => void;
  saving: boolean;
}) {
  return (
    <div className="flex justify-end gap-2 pt-2">
      <Button variant="outline" size="sm" onClick={onCancel} disabled={saving}>
        <X className="mr-1.5 h-3.5 w-3.5" />
        Cancel
      </Button>
      <Button
        size="sm"
        onClick={onSave}
        disabled={saving}
        className="bg-[#006747] hover:bg-[#00563b]"
      >
        <Check className="mr-1.5 h-3.5 w-3.5" />
        {saving ? "Saving…" : "Save"}
      </Button>
    </div>
  );
}

// ─── component ───────────────────────────────────────────────────────────────

export function StudentInfoEditor({ initialStudent }: StudentInfoEditorProps) {
  const [student, setStudent] = useState<Student>(initialStudent);

  // Which section is currently being edited
  const [editingSection, setEditingSection] = useState<
    "basic" | "academic" | "personal" | null
  >(null);
  const [saving, setSaving] = useState(false);

  // Draft state – one flat object covering all fields
  const [draft, setDraft] = useState({
    full_name: student.full_name,
    email: student.email,
    is_ch_student: student.is_ch_student,
    major: student.major ?? "",
    minor: student.minor ?? "",
    class_standing: student.class_standing ?? "",
    gpa: student.gpa != null ? String(student.gpa) : "",
    honors_college: student.honors_college,
    languages: student.languages ?? "",
    age: student.age != null ? String(student.age) : "",
    gender: student.gender ?? "",
    pronouns: student.pronouns ?? "",
    race_ethnicity: student.race_ethnicity ?? "",
    first_gen: student.first_gen,
    us_citizen: student.us_citizen,
  });
  const [errors, setErrors] = useState<Record<string, string>>({});

  const startEdit = (section: "basic" | "academic" | "personal") => {
    // Reset draft from live student state
    setDraft({
      full_name: student.full_name,
      email: student.email,
      is_ch_student: student.is_ch_student,
      major: student.major ?? "",
      minor: student.minor ?? "",
      class_standing: student.class_standing ?? "",
      gpa: student.gpa != null ? String(student.gpa) : "",
      honors_college: student.honors_college,
      languages: student.languages ?? "",
      age: student.age != null ? String(student.age) : "",
      gender: student.gender ?? "",
      pronouns: student.pronouns ?? "",
      race_ethnicity: student.race_ethnicity ?? "",
      first_gen: student.first_gen,
      us_citizen: student.us_citizen,
    });
    setErrors({});
    setEditingSection(section);
  };

  const cancelEdit = () => {
    setEditingSection(null);
    setErrors({});
  };

  const validate = (section: "basic" | "academic" | "personal") => {
    const e: Record<string, string> = {};
    if (section === "basic") {
      if (!draft.full_name.trim()) e.full_name = "Name is required.";
      if (!draft.email.trim()) {
        e.email = "Email is required.";
      } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(draft.email)) {
        e.email = "Invalid email format.";
      }
    }
    if (section === "academic" && draft.gpa !== "") {
      const g = parseFloat(draft.gpa);
      if (isNaN(g) || g < 0 || g > 4.0) e.gpa = "GPA must be between 0.0 and 4.0.";
    }
    if (section === "personal" && draft.age !== "") {
      const a = parseInt(draft.age);
      if (isNaN(a) || a < 1 || a > 120) e.age = "Enter a valid age.";
    }
    return e;
  };

  const saveSection = async (section: "basic" | "academic" | "personal") => {
    const e = validate(section);
    setErrors(e);
    if (Object.keys(e).length > 0) return;

    const payload: Partial<Student> = {};

    if (section === "basic") {
      payload.full_name = draft.full_name.trim();
      payload.email = draft.email.trim();
      payload.is_ch_student = draft.is_ch_student;
    } else if (section === "academic") {
      payload.major = draft.major || null;
      payload.minor = draft.minor || null;
      payload.class_standing = draft.class_standing || null;
      payload.gpa = draft.gpa !== "" ? parseFloat(draft.gpa) : null;
      payload.honors_college = draft.honors_college;
      payload.languages = draft.languages || null;
    } else {
      payload.age = draft.age !== "" ? parseInt(draft.age) : null;
      payload.gender = draft.gender || null;
      payload.pronouns = draft.pronouns || null;
      payload.race_ethnicity = draft.race_ethnicity || null;
      payload.first_gen = draft.first_gen;
      payload.us_citizen = draft.us_citizen;
    }

    setSaving(true);
    try {
      const { data, error } = await supabaseBrowserClient
        .from("student")
        .update(payload)
        .eq("student_id", student.student_id)
        .select()
        .single();

      if (error) throw error;

      setStudent(data as Student);
      setEditingSection(null);
      toast.success("Student updated.");
    } catch (err) {
      console.error(err);
      toast.error("Failed to save changes.");
    } finally {
      setSaving(false);
    }
  };

  // ── Checkbox helper ────────────────────────────────────────────────────────
  const Checkbox = ({
    id,
    field,
    label,
  }: {
    id: string;
    field: keyof typeof draft;
    label: string;
  }) => (
    <div className="flex items-center gap-2">
      <input
        type="checkbox"
        id={id}
        checked={draft[field] as boolean}
        onChange={(e) => setDraft((prev) => ({ ...prev, [field]: e.target.checked }))}
        className="h-4 w-4 rounded border-gray-300 text-[#006747] focus:ring-[#006747]"
      />
      <Label htmlFor={id} className="cursor-pointer text-sm">
        {label}
      </Label>
    </div>
  );

  // ─────────────────────────────────────────────────────────────────────────
  return (
    <div className="space-y-6">
      {/* ── Basic Information ─────────────────────────────────────────────── */}
      <Card className="border-gray-200 shadow-sm">
        <CardHeader className="flex flex-row items-center justify-between pb-2">
          <CardTitle className="text-lg">Basic Information</CardTitle>
          {editingSection !== "basic" && (
            <SectionEditButton onClick={() => startEdit("basic")} />
          )}
        </CardHeader>
        <CardContent className="space-y-4">
          {editingSection === "basic" ? (
            <>
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="b_full_name">
                    Full Name <span className="text-red-500">*</span>
                  </Label>
                  <Input
                    id="b_full_name"
                    value={draft.full_name}
                    onChange={(e) => setDraft((p) => ({ ...p, full_name: e.target.value }))}
                  />
                  {errors.full_name && (
                    <p className="text-xs text-red-600">{errors.full_name}</p>
                  )}
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="b_email">
                    Email <span className="text-red-500">*</span>
                  </Label>
                  <Input
                    id="b_email"
                    type="email"
                    value={draft.email}
                    onChange={(e) => setDraft((p) => ({ ...p, email: e.target.value }))}
                  />
                  {errors.email && (
                    <p className="text-xs text-red-600">{errors.email}</p>
                  )}
                </div>
              </div>
              <Checkbox id="b_is_ch_student" field="is_ch_student" label="CH Student" />
              <SectionSaveRow
                onSave={() => saveSection("basic")}
                onCancel={cancelEdit}
                saving={saving}
              />
            </>
          ) : (
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <label className="text-sm font-medium text-slate-500">Full Name</label>
                <p className="mt-1 text-sm text-slate-900">{student.full_name}</p>
              </div>
              <div>
                <label className="text-sm font-medium text-slate-500">Email</label>
                <div className="mt-1 flex items-center gap-2">
                  <Mail className="h-4 w-4 text-slate-400" />
                  <a
                    href={`mailto:${student.email}`}
                    className="text-sm text-blue-600 hover:underline"
                  >
                    {student.email}
                  </a>
                </div>
              </div>
              <div>
                <label className="text-sm font-medium text-slate-500">Student ID</label>
                <p className="mt-1 text-sm text-slate-900">{student.student_id}</p>
              </div>
              <div>
                <label className="text-sm font-medium text-slate-500">Status</label>
                <div className="mt-1">
                  {student.is_ch_student ? (
                    <Badge className="border-green-200 bg-green-100 text-green-800 hover:bg-green-100">
                      CH Student
                    </Badge>
                  ) : (
                    <Badge
                      variant="secondary"
                      className="border-gray-200 bg-gray-100 text-gray-700 hover:bg-gray-100"
                    >
                      Other
                    </Badge>
                  )}
                </div>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* ── Academic Information ──────────────────────────────────────────── */}
      <Card className="border-gray-200 shadow-sm">
        <CardHeader className="flex flex-row items-center justify-between pb-2">
          <CardTitle className="text-lg">Academic Information</CardTitle>
          {editingSection !== "academic" && (
            <SectionEditButton onClick={() => startEdit("academic")} />
          )}
        </CardHeader>
        <CardContent className="space-y-4">
          {editingSection === "academic" ? (
            <>
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                <div className="space-y-1.5">
                  <Label htmlFor="a_major">Major</Label>
                  <Input
                    id="a_major"
                    value={draft.major}
                    onChange={(e) => setDraft((p) => ({ ...p, major: e.target.value }))}
                    placeholder="e.g. Computer Science"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="a_minor">Minor</Label>
                  <Input
                    id="a_minor"
                    value={draft.minor}
                    onChange={(e) => setDraft((p) => ({ ...p, minor: e.target.value }))}
                    placeholder="e.g. Mathematics"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="a_class_standing">Class Standing</Label>
                  <Select
                    value={draft.class_standing || "none"}
                    onValueChange={(v) =>
                      setDraft((p) => ({ ...p, class_standing: v === "none" ? "" : v }))
                    }
                  >
                    <SelectTrigger id="a_class_standing">
                      <SelectValue placeholder="Select…" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">— None —</SelectItem>
                      <SelectItem value="Freshman">Freshman</SelectItem>
                      <SelectItem value="Sophomore">Sophomore</SelectItem>
                      <SelectItem value="Junior">Junior</SelectItem>
                      <SelectItem value="Senior">Senior</SelectItem>
                      <SelectItem value="Graduate">Graduate</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="a_gpa">GPA</Label>
                  <Input
                    id="a_gpa"
                    type="number"
                    step="0.01"
                    min="0"
                    max="4.0"
                    value={draft.gpa}
                    onChange={(e) => setDraft((p) => ({ ...p, gpa: e.target.value }))}
                    placeholder="0.00 – 4.00"
                  />
                  {errors.gpa && <p className="text-xs text-red-600">{errors.gpa}</p>}
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="a_languages">Languages</Label>
                  <Input
                    id="a_languages"
                    value={draft.languages}
                    onChange={(e) => setDraft((p) => ({ ...p, languages: e.target.value }))}
                    placeholder="e.g. English, Spanish"
                  />
                </div>
              </div>
              <Checkbox id="a_honors_college" field="honors_college" label="Honors College" />
              <SectionSaveRow
                onSave={() => saveSection("academic")}
                onCancel={cancelEdit}
                saving={saving}
              />
            </>
          ) : (
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              <div>
                <label className="text-sm font-medium text-slate-500">Major</label>
                <div className="mt-1 flex items-center gap-2">
                  <GraduationCap className="h-4 w-4 text-slate-400" />
                  <p className="text-sm text-slate-900">{student.major || "—"}</p>
                </div>
              </div>
              <div>
                <label className="text-sm font-medium text-slate-500">Minor</label>
                <p className="mt-1 text-sm text-slate-900">{student.minor || "—"}</p>
              </div>
              <div>
                <label className="text-sm font-medium text-slate-500">Class Standing</label>
                <p className="mt-1 text-sm text-slate-900">{student.class_standing || "—"}</p>
              </div>
              <div>
                <label className="text-sm font-medium text-slate-500">GPA</label>
                <p className="mt-1 text-sm text-slate-900">
                  {student.gpa != null ? student.gpa.toFixed(2) : "—"}
                </p>
              </div>
              <div>
                <label className="text-sm font-medium text-slate-500">Honors College</label>
                <p className="mt-1 text-sm text-slate-900">
                  {student.honors_college ? "Yes" : "No"}
                </p>
              </div>
              <div>
                <label className="text-sm font-medium text-slate-500">Languages</label>
                <p className="mt-1 text-sm text-slate-900">{student.languages || "—"}</p>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* ── Personal Information ──────────────────────────────────────────── */}
      <Card className="border-gray-200 shadow-sm">
        <CardHeader className="flex flex-row items-center justify-between pb-2">
          <CardTitle className="text-lg">Personal Information</CardTitle>
          {editingSection !== "personal" && (
            <SectionEditButton onClick={() => startEdit("personal")} />
          )}
        </CardHeader>
        <CardContent className="space-y-4">
          {editingSection === "personal" ? (
            <>
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                <div className="space-y-1.5">
                  <Label htmlFor="p_age">Age</Label>
                  <Input
                    id="p_age"
                    type="number"
                    min="1"
                    max="120"
                    value={draft.age}
                    onChange={(e) => setDraft((p) => ({ ...p, age: e.target.value }))}
                    placeholder="e.g. 21"
                  />
                  {errors.age && <p className="text-xs text-red-600">{errors.age}</p>}
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="p_gender">Gender</Label>
                  <Input
                    id="p_gender"
                    value={draft.gender}
                    onChange={(e) => setDraft((p) => ({ ...p, gender: e.target.value }))}
                    placeholder="e.g. Female"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="p_pronouns">Pronouns</Label>
                  <Input
                    id="p_pronouns"
                    value={draft.pronouns}
                    onChange={(e) => setDraft((p) => ({ ...p, pronouns: e.target.value }))}
                    placeholder="e.g. she/her"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="p_race_ethnicity">Race / Ethnicity</Label>
                  <Input
                    id="p_race_ethnicity"
                    value={draft.race_ethnicity}
                    onChange={(e) =>
                      setDraft((p) => ({ ...p, race_ethnicity: e.target.value }))
                    }
                    placeholder="e.g. Hispanic or Latino"
                  />
                </div>
              </div>
              <div className="flex flex-wrap gap-4">
                <Checkbox id="p_first_gen" field="first_gen" label="First Generation" />
                <Checkbox id="p_us_citizen" field="us_citizen" label="US Citizen" />
              </div>
              <SectionSaveRow
                onSave={() => saveSection("personal")}
                onCancel={cancelEdit}
                saving={saving}
              />
            </>
          ) : (
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              <div>
                <label className="text-sm font-medium text-slate-500">Age</label>
                <p className="mt-1 text-sm text-slate-900">{student.age || "—"}</p>
              </div>
              <div>
                <label className="text-sm font-medium text-slate-500">Gender</label>
                <p className="mt-1 text-sm text-slate-900">{student.gender || "—"}</p>
              </div>
              <div>
                <label className="text-sm font-medium text-slate-500">Pronouns</label>
                <p className="mt-1 text-sm text-slate-900">{student.pronouns || "—"}</p>
              </div>
              <div>
                <label className="text-sm font-medium text-slate-500">Race/Ethnicity</label>
                <p className="mt-1 text-sm text-slate-900">{student.race_ethnicity || "—"}</p>
              </div>
              <div>
                <label className="text-sm font-medium text-slate-500">First Generation</label>
                <p className="mt-1 text-sm text-slate-900">
                  {student.first_gen ? "Yes" : "No"}
                </p>
              </div>
              <div>
                <label className="text-sm font-medium text-slate-500">US Citizen</label>
                <p className="mt-1 text-sm text-slate-900">
                  {student.us_citizen ? "Yes" : "No"}
                </p>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
