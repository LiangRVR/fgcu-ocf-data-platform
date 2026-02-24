import type { Metadata } from "next";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { UserPlus } from "lucide-react";

export const metadata: Metadata = { title: "Students" };

export default function StudentsPage() {
  return (
    <>
      <PageHeader
        title="Students"
        description="Manage fellowship-eligible students."
      >
        <Button size="sm">
          <UserPlus className="mr-2 h-4 w-4" />
          Add Student
        </Button>
      </PageHeader>

      <Card>
        <CardContent className="py-12 text-center">
          <p className="text-sm text-muted-foreground">
            Student table will appear here. Connect Supabase to load data.
          </p>
        </CardContent>
      </Card>
    </>
  );
}
