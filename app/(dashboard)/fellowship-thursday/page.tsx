import type { Metadata } from "next";
import { PageHeader } from "@/components/layout/page-header";
import { createServerClient } from "@/lib/supabase/server";
import { FellowshipThursdayTable } from "@/components/fellowship-thursday/fellowship-thursday-table";
import type { Database } from "@/types/database";

export const metadata: Metadata = { title: "Fellowship Thursday" };

type FellowshipThursday =
  Database["public"]["Tables"]["fellowship_thursday"]["Row"] & {
    student: { full_name: string } | null;
  };

type StudentRow = Pick<
  Database["public"]["Tables"]["student"]["Row"],
  "student_id" | "full_name"
>;

async function getFellowshipThursdayRecords(): Promise<FellowshipThursday[]> {
  const supabase = createServerClient();
  try {
    const { data, error } = await supabase
      .from("fellowship_thursday")
      .select(`*, student(full_name)`)
      .order("attendance_id", { ascending: false });
    if (error) {
      console.error("Error fetching fellowship thursday records:", error);
      return [];
    }
    return (data as FellowshipThursday[]) || [];
  } catch {
    return [];
  }
}

async function getStudents(): Promise<StudentRow[]> {
  const supabase = createServerClient();
  try {
    const { data } = await supabase
      .from("student")
      .select("student_id, full_name")
      .order("full_name", { ascending: true });
    return data || [];
  } catch {
    return [];
  }
}

export default async function FellowshipThursdayPage() {
  const [records, students] = await Promise.all([
    getFellowshipThursdayRecords(),
    getStudents(),
  ]);

  return (
    <>
      <PageHeader
        title="Fellowship Thursday"
        description="Track student attendance at weekly Thursday fellowship meetings"
      />
      <FellowshipThursdayTable initialRecords={records} students={students} />
    </>
  );
}
