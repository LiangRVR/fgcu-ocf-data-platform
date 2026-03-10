"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Pencil } from "lucide-react";
import { toast } from "sonner";
import { supabaseBrowserClient } from "@/lib/supabase/client";
import { useRouter } from "next/navigation";

interface FellowshipEditButtonProps {
  fellowshipId: number;
  fellowshipName: string;
}

export function FellowshipEditButton({
  fellowshipId,
  fellowshipName,
}: FellowshipEditButtonProps) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(fellowshipName);
  const [saving, setSaving] = useState(false);
  const router = useRouter();

  async function handleSave() {
    const trimmed = name.trim();
    if (!trimmed) return;
    setSaving(true);
    try {
      const { error } = await supabaseBrowserClient
        .from("fellowship")
        .update({ fellowship_name: trimmed })
        .eq("fellowship_id", fellowshipId);

      if (error) throw error;

      toast.success("Fellowship updated");
      setOpen(false);
      router.refresh();
    } catch {
      toast.error("Failed to update fellowship");
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <Button
        variant="ghost"
        size="icon"
        className="h-8 w-8 text-slate-600 hover:text-slate-900"
        title="Edit fellowship"
        onClick={() => {
          setName(fellowshipName);
          setOpen(true);
        }}
      >
        <Pencil className="h-4 w-4" />
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Edit Fellowship</DialogTitle>
          </DialogHeader>
          <div className="mt-2 grid gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="fellowship-name">Fellowship Name</Label>
              <Input
                id="fellowship-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleSave()}
                autoFocus
              />
            </div>
            <div className="flex justify-end gap-2 pt-1">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setOpen(false)}
                disabled={saving}
              >
                Cancel
              </Button>
              <Button
                size="sm"
                className="bg-[#006747] hover:bg-[#00563b]"
                onClick={handleSave}
                disabled={saving || !name.trim()}
              >
                {saving ? "Saving…" : "Save"}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
