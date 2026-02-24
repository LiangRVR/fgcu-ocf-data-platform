import type { Metadata } from "next";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Download } from "lucide-react";

export const metadata: Metadata = { title: "Reports" };

export default function ReportsPage() {
  return (
    <>
      <PageHeader
        title="Reports"
        description="Generate and export fellowship program reports."
      >
        <Button variant="outline" size="sm">
          <Download className="mr-2 h-4 w-4" />
          Export
        </Button>
      </PageHeader>

      <Card>
        <CardContent className="py-12 text-center">
          <p className="text-sm text-muted-foreground">
            Report charts and tables will appear here. Connect Supabase to load data.
          </p>
        </CardContent>
      </Card>
    </>
  );
}
