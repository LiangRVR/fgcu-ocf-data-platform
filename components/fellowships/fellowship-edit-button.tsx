"use client";

import { useRef, useState } from "react";
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
import {
  STALE_VERSION_GUIDANCE,
  isVersionConflict,
} from "@/lib/supabase/errors";
import { useRouter } from "next/navigation";

interface FellowshipEditButtonProps {
  fellowshipId: number;
  fellowshipName: string;
  disabled?: boolean;
}

export function FellowshipEditButton({
  fellowshipId,
  fellowshipName,
  disabled = false,
}: FellowshipEditButtonProps) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(fellowshipName);
  const [isDirty, setIsDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  // Loaded optimistic-concurrency version; read from the base table when the
  // dialog opens (the list view does not carry it). Never re-read at save time.
  const [expectedVersion, setExpectedVersion] = useState<number | null>(null);
  const editStarted = useRef(false);
  const router = useRouter();

  async function handleOpen() {
    editStarted.current = false;
    setName(fellowshipName);
    setIsDirty(false);
    setExpectedVersion(null);
    setOpen(true);
    const { data, error } = await supabaseBrowserClient
      .from("fellowship")
      .select("fellowship_name, row_version")
      .eq("fellowship_id", fellowshipId)
      .single();
    if (!error && data) {
      // The displayed value and expected version must be one database snapshot.
      if (!editStarted.current) setName(data.fellowship_name);
      setExpectedVersion(data.row_version);
    }
  }

  async function handleSave() {
    const trimmed = name.trim();
    if (!trimmed) return;
    if (expectedVersion == null) {
      // Fail closed: the loaded version is not available.
      toast.error(STALE_VERSION_GUIDANCE);
      return;
    }
    setSaving(true);
    try {
      const { data, error } = await supabaseBrowserClient.rpc(
        "update_fellowship",
        {
          p_fellowship_id: fellowshipId,
          p_expected_version: expectedVersion,
          p_fellowship_name: trimmed,
        },
      );

      if (error) {
        if (isVersionConflict(error)) {
          // Keep the edited name visible for review. No retry, no overwrite.
          toast.error(STALE_VERSION_GUIDANCE);
          return;
        }
        throw error;
      }

      const updated = Array.isArray(data) ? data[0] : data;
      if (updated) setExpectedVersion(updated.row_version);

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
        onClick={() => void handleOpen()}
        disabled={disabled}
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
                onChange={(e) => { editStarted.current = true; setName(e.target.value); setIsDirty(true); }}
                onBlur={() => setIsDirty(true)}
                onKeyDown={(e) => e.key === "Enter" && handleSave()}
                autoFocus
              />
              {isDirty && !name.trim() && (
                <p className="text-xs text-destructive">Name is required</p>
              )}
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
