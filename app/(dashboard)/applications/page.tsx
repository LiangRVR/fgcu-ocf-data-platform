import type { Metadata } from "next";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { FilePlus } from "lucide-react";

export const metadata: Metadata = { title: "Applications" };

export default function ApplicationsPage() {
  return (
    <>
      <PageHeader
        title="Applications"
        description="Track student fellowship applications and statuses."
      >
        <Button size="sm">
          <FilePlus className="mr-2 h-4 w-4" />
          New Application
        </Button>
      </PageHeader>

      <Card>
        <CardContent className="py-12 text-center">
          <p className="text-sm text-muted-foreground">
            Application table will appear here. Connect Supabase to load data.
          </p>
        </CardContent>
      </Card>
    </>
  );
}
