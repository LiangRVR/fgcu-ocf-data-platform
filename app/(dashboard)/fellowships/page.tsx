import type { Metadata } from "next";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import Link from "next/link";
import { Plus, Search, Eye, Trash2, Award } from "lucide-react";
import { FellowshipEditButton } from "@/components/fellowships/fellowship-edit-button";
import { createServerClient } from "@/lib/supabase/server";
import type { Database } from "@/types/database";

export const metadata: Metadata = { title: "Fellowships" };

type Fellowship = Database["public"]["Tables"]["fellowship"]["Row"];
type Application = Database["public"]["Tables"]["application"]["Row"];

interface FellowshipWithMetrics extends Fellowship {
  totalApplications: number;
  finalists: number;
  awardedStudents: number;
}

/**
 * Fetch all fellowships from the database
 */
async function getFellowships(): Promise<Fellowship[]> {
  const supabase = createServerClient();

  try {
    const { data, error } = await supabase
      .from("fellowship")
      .select("*")
      .order("fellowship_name", { ascending: true });

    if (error) {
      console.error("Error fetching fellowships:", error);
      return [];
    }

    return data || [];
  } catch (error) {
    console.error("Error fetching fellowships:", error);
    return [];
  }
}

/**
 * Fetch application metrics grouped by fellowship
 */
async function getApplicationMetrics(): Promise<Application[]> {
  const supabase = createServerClient();

  try {
    const { data, error } = await supabase
      .from("application")
      .select("fellowship_id, is_finalist, stage_of_application");

    if (error) {
      console.error("Error fetching application metrics:", error);
      return [];
    }

    return (data as Application[]) || [];
  } catch {
    return [];
  }
}

export default async function FellowshipsPage() {
  const [fellowships, applications] = await Promise.all([
    getFellowships(),
    getApplicationMetrics(),
  ]);

  // Derive per-fellowship metrics from the flat applications list
  const metricsMap = new Map<
    number,
    { totalApplications: number; finalists: number; awardedStudents: number }
  >();
  for (const app of applications) {
    const existing = metricsMap.get(app.fellowship_id) ?? {
      totalApplications: 0,
      finalists: 0,
      awardedStudents: 0,
    };
    existing.totalApplications += 1;
    if (app.is_finalist) existing.finalists += 1;
    if (app.stage_of_application === "Awarded") existing.awardedStudents += 1;
    metricsMap.set(app.fellowship_id, existing);
  }

  const fellowshipsWithMetrics: FellowshipWithMetrics[] = fellowships.map(
    (f) => ({
      ...f,
      ...(metricsMap.get(f.fellowship_id) ?? {
        totalApplications: 0,
        finalists: 0,
        awardedStudents: 0,
      }),
    })
  );

  // Summary stats across all fellowships
  const totalApplicationsAll = fellowshipsWithMetrics.reduce(
    (sum, f) => sum + f.totalApplications,
    0
  );
  const totalFinalistsAll = fellowshipsWithMetrics.reduce(
    (sum, f) => sum + f.finalists,
    0
  );
  const totalAwardedAll = fellowshipsWithMetrics.reduce(
    (sum, f) => sum + f.awardedStudents,
    0
  );

  return (
    <>
      <PageHeader
        title="Fellowships"
        description="Browse and manage available fellowship opportunities"
      >
        <Button size="sm" className="bg-[#006747] hover:bg-[#00563b]">
          <Plus className="mr-2 h-4 w-4" />
          Add Fellowship
        </Button>
      </PageHeader>

      {/* Summary KPI Cards */}
      <div className="mb-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Card className="border-gray-200 shadow-sm">
          <CardContent className="p-4">
            <p className="text-xs font-medium uppercase tracking-wide text-gray-500">Fellowships</p>
            <p className="mt-1 text-2xl font-bold text-slate-900">{fellowshipsWithMetrics.length}</p>
          </CardContent>
        </Card>
        <Card className="border-gray-200 shadow-sm">
          <CardContent className="p-4">
            <p className="text-xs font-medium uppercase tracking-wide text-gray-500">Total Applications</p>
            <p className="mt-1 text-2xl font-bold text-slate-900">{totalApplicationsAll}</p>
          </CardContent>
        </Card>
        <Card className="border-gray-200 shadow-sm">
          <CardContent className="p-4">
            <p className="text-xs font-medium uppercase tracking-wide text-gray-500">Finalists</p>
            <p className="mt-1 text-2xl font-bold text-[#006747]">{totalFinalistsAll}</p>
          </CardContent>
        </Card>
        <Card className="border-gray-200 shadow-sm">
          <CardContent className="p-4">
            <p className="text-xs font-medium uppercase tracking-wide text-gray-500">Awarded</p>
            <p className="mt-1 text-2xl font-bold text-[#006747]">{totalAwardedAll}</p>
          </CardContent>
        </Card>
      </div>

      {/* Search Bar */}
      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="relative w-full sm:w-72">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
          <Input
            placeholder="Search fellowships..."
            className="pl-9"
          />
        </div>
      </div>

      {/* Fellowships Table */}
      <Card className="border-gray-200 shadow-sm">
        <CardContent className="p-0">
          {fellowshipsWithMetrics.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16">
              <div className="mb-4 flex h-20 w-20 items-center justify-center rounded-full bg-gray-100">
                <Award className="h-10 w-10 text-gray-400" />
              </div>
              <h3 className="mb-2 text-lg font-semibold text-slate-900">No fellowships found</h3>
              <p className="mb-4 text-sm text-slate-500">Get started by adding your first fellowship opportunity.</p>
              <Button className="bg-[#006747] hover:bg-[#00563b]">
                <Plus className="mr-2 h-4 w-4" />
                Add Fellowship
              </Button>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead className="bg-gray-50">
                  <tr className="border-b border-gray-200">
                    <th className="px-6 py-3 text-left text-xs font-medium uppercase tracking-wide text-gray-500">Name</th>
                    <th className="px-6 py-3 text-right text-xs font-medium uppercase tracking-wide text-gray-500">Applications</th>
                    <th className="px-6 py-3 text-right text-xs font-medium uppercase tracking-wide text-gray-500">Finalists</th>
                    <th className="px-6 py-3 text-right text-xs font-medium uppercase tracking-wide text-gray-500">Awarded</th>
                    <th className="px-6 py-3 text-right text-xs font-medium uppercase tracking-wide text-gray-500">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-200 bg-white">
                  {fellowshipsWithMetrics.map((fellowship) => (
                    <tr
                      key={fellowship.fellowship_id}
                      className="transition-colors duration-150 hover:bg-gray-50"
                    >
                      <td className="whitespace-nowrap px-6 py-4">
                        <Link
                          href={`/fellowships/${fellowship.fellowship_id}`}
                          className="font-medium text-slate-900 hover:text-[#006747] hover:underline"
                        >
                          {fellowship.fellowship_name}
                        </Link>
                      </td>
                      <td className="whitespace-nowrap px-6 py-4 text-right">
                        <span className="text-sm font-medium text-slate-700">{fellowship.totalApplications}</span>
                      </td>
                      <td className="whitespace-nowrap px-6 py-4 text-right">
                        <span className="text-sm font-medium text-slate-700">{fellowship.finalists}</span>
                      </td>
                      <td className="whitespace-nowrap px-6 py-4 text-right">
                        <span className={`text-sm font-medium ${fellowship.awardedStudents > 0 ? "text-[#006747]" : "text-slate-700"}`}>
                          {fellowship.awardedStudents}
                        </span>
                      </td>
                      <td className="whitespace-nowrap px-6 py-4">
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
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8 text-slate-600 hover:text-red-600"
                            title="Delete fellowship"
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Pagination */}
      {fellowshipsWithMetrics.length > 0 && (
        <div className="mt-4 flex items-center justify-between">
          <div className="text-sm text-slate-500">
            Showing <span className="font-medium">1</span>–<span className="font-medium">{fellowshipsWithMetrics.length}</span> of{" "}
            <span className="font-medium">{fellowshipsWithMetrics.length}</span> fellowships
          </div>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" disabled>
              Previous
            </Button>
            <Button variant="outline" size="sm" disabled>
              Next
            </Button>
          </div>
        </div>
      )}
    </>
  );
}
