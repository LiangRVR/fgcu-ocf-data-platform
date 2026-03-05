import type { Metadata } from "next";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Plus, Search, Eye, Pencil, Trash2, Award } from "lucide-react";
import { createServerClient } from "@/lib/supabase/server";
import type { Database } from "@/types/database";

export const metadata: Metadata = { title: "Fellowships" };

type Fellowship = Database["public"]["Tables"]["fellowship"]["Row"];

/**
 * Fetch all fellowships from the database
 */
async function getFellowships(): Promise<Fellowship[]> {
  const supabase = createServerClient();

  try {
    const { data, error } = await supabase
      .from("fellowship")
      .select("*")
      .order("fellowship_id", { ascending: false });

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

export default async function FellowshipsPage() {
  const fellowships = await getFellowships();

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
          {fellowships.length === 0 ? (
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
                    <th className="px-6 py-3 text-left text-xs font-medium uppercase tracking-wide text-gray-500">Fellowship ID</th>
                    <th className="px-6 py-3 text-right text-xs font-medium uppercase tracking-wide text-gray-500">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-200 bg-white">
                  {fellowships.map((fellowship) => (
                    <tr
                      key={fellowship.fellowship_id}
                      className="cursor-pointer transition-colors duration-150 hover:bg-gray-50"
                    >
                      <td className="whitespace-nowrap px-6 py-4">
                        <div className="font-medium text-slate-900">{fellowship.fellowship_name}</div>
                      </td>
                      <td className="whitespace-nowrap px-6 py-4">
                        <div className="text-sm text-slate-600">{fellowship.fellowship_id}</div>
                      </td>
                      <td className="whitespace-nowrap px-6 py-4">
                        <div className="flex items-center justify-end gap-2">
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8 text-slate-600 hover:text-slate-900"
                            title="View fellowship"
                          >
                            <Eye className="h-4 w-4" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8 text-slate-600 hover:text-slate-900"
                            title="Edit fellowship"
                          >
                            <Pencil className="h-4 w-4" />
                          </Button>
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
      {fellowships.length > 0 && (
        <div className="mt-4 flex items-center justify-between">
          <div className="text-sm text-slate-500">
            Showing <span className="font-medium">1</span>–<span className="font-medium">{fellowships.length}</span> of{" "}
            <span className="font-medium">{fellowships.length}</span> fellowships
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
