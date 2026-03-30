"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Plus } from "lucide-react";
import { toast } from "sonner";
import { supabaseBrowserClient } from "@/lib/supabase/client";
import { useRouter } from "next/navigation";

interface AddFellowshipButtonProps {
  /** Rendered as the trigger. Defaults to a standard "Add Fellowship" button. */
  variant?: "default" | "outline";
  size?: "default" | "sm";
}

export function AddFellowshipButton({
  variant = "default",
  size = "sm",
}: AddFellowshipButtonProps) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const router = useRouter();

  function handleOpen() {
    setName("");
    setError("");
    setOpen(true);
  }

  async function handleSave() {
    const trimmed = name.trim();
    if (!trimmed) {
      setError("Fellowship name is required.");
      return;
    }
    setError("");
    setSaving(true);
    try {
      const { error: dbError } = await supabaseBrowserClient
        .from("fellowship")
        .insert({ fellowship_name: trimmed });

      if (dbError) {
        // Unique-violation code
        if (dbError.code === "23505") {
          setError("A fellowship with this name already exists.");
        } else {
          throw dbError;
        }
        return;
      }

      toast.success("Fellowship added");
      setOpen(false);
      router.refresh();
    } catch {
      toast.error("Failed to add fellowship");
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <Button variant={variant} size={size} onClick={handleOpen}>
        <Plus className="mr-2 h-4 w-4" />
        Add Fellowship
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Add Fellowship</DialogTitle>
            <DialogDescription>
              Enter a unique name for the new fellowship program.
            </DialogDescription>
          </DialogHeader>
          <div className="mt-2 grid gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="new-fellowship-name">
                Fellowship Name <span className="text-red-500">*</span>
              </Label>
              <Input
                id="new-fellowship-name"
                value={name}
                onChange={(e) => {
                  setName(e.target.value);
                  if (error) setError("");
                }}
                onKeyDown={(e) => e.key === "Enter" && handleSave()}
                placeholder="e.g. Fulbright Scholarship"
                autoFocus
              />
              {error && <p className="text-sm text-red-600">{error}</p>}
            </div>
          </div>
          <DialogFooter className="mt-2">
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
              {saving ? "Adding…" : "Add Fellowship"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
