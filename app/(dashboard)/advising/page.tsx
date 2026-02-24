import type { Metadata } from "next";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { CalendarPlus } from "lucide-react";

export const metadata: Metadata = { title: "Advising" };

export default function AdvisingPage() {
  return (
    <>
      <PageHeader
        title="Advising"
        description="Schedule and track advising sessions with students."
      >
        <Button size="sm">
          <CalendarPlus className="mr-2 h-4 w-4" />
          Schedule Session
        </Button>
      </PageHeader>

      <Card>
        <CardContent className="py-12 text-center">
          <p className="text-sm text-muted-foreground">
            Advising sessions will appear here. Connect Supabase to load data.
          </p>
        </CardContent>
      </Card>
    </>
  );
}
