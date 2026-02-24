import type { Metadata } from "next";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Plus } from "lucide-react";

export const metadata: Metadata = { title: "Fellowships" };

export default function FellowshipsPage() {
  return (
    <>
      <PageHeader
        title="Fellowships"
        description="Browse and manage available fellowship opportunities."
      >
        <Button size="sm">
          <Plus className="mr-2 h-4 w-4" />
          Add Fellowship
        </Button>
      </PageHeader>

      <Card>
        <CardContent className="py-12 text-center">
          <p className="text-sm text-muted-foreground">
            Fellowship table will appear here. Connect Supabase to load data.
          </p>
        </CardContent>
      </Card>
    </>
  );
}
