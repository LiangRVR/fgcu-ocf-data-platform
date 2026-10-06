"use client";

import { useState } from "react";
import { FilePenLine } from "lucide-react";
import { toast } from "sonner";
import { supabaseBrowserClient } from "@/lib/supabase/client";
import type { Database } from "@/types/database";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";

type Amendment = Database["public"]["Tables"]["advising_meeting_amendment"]["Row"] & {
  created_by: { advisor_name: string } | null;
};

export function AddCorrection({ meetingId, onSaved }: { meetingId: number; onSaved?: (amendment: Amendment) => void }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [details, setDetails] = useState("");
  const [errors, setErrors] = useState<{ reason?: string; details?: string }>({});
  const [loading, setLoading] = useState(false);

  const close = () => {
    if (loading) return;
    setOpen(false);
    setReason("");
    setDetails("");
    setErrors({});
  };

  const submit = async () => {
    const next = { reason: reason.trim() ? undefined : "Reason is required.", details: details.trim() ? undefined : "Details are required." };
    setErrors(next);
    if (next.reason || next.details) return;
    setLoading(true);
    try {
      const { data, error } = await supabaseBrowserClient.from("advising_meeting_amendment").insert({
        meeting_id: meetingId, reason: reason.trim(), details: details.trim(),
      } as Database["public"]["Tables"]["advising_meeting_amendment"]["Insert"])
        .select("amendment_id, meeting_id, reason, details, created_at, created_by_advisor_id, created_by:advisor!advising_meeting_amendment_created_by_advisor_id_fkey(advisor_name)").single();
      if (error) throw error;
      onSaved?.(data as Amendment);
      toast.success("Correction added to the meeting history.");
      setOpen(false);
      setReason(""); setDetails(""); setErrors({});
    } catch (error) {
      console.error(error);
      toast.error("Failed to add correction.");
    } finally { setLoading(false); }
  };

  return <>
    <Button type="button" variant="outline" size="sm" className="h-8 gap-1.5 text-xs" onClick={() => setOpen(true)}>
      <FilePenLine aria-hidden="true" className="h-3.5 w-3.5" /> Add Correction
    </Button>
    <Dialog open={open} onOpenChange={(value) => !value && close()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader><DialogTitle>Add Correction</DialogTitle><DialogDescription>Add an attached historical correction. The original meeting remains unchanged.</DialogDescription></DialogHeader>
        <div className="grid gap-4 py-2">
          <div className="grid gap-1.5"><Label htmlFor={`correction-reason-${meetingId}`}>Reason <span className="text-red-500">*</span></Label><Input id={`correction-reason-${meetingId}`} value={reason} aria-invalid={Boolean(errors.reason)} aria-describedby={errors.reason ? `reason-error-${meetingId}` : undefined} onChange={(event) => setReason(event.target.value)} />{errors.reason && <p id={`reason-error-${meetingId}`} role="alert" className="text-xs text-red-600">{errors.reason}</p>}</div>
          <div className="grid gap-1.5"><Label htmlFor={`correction-details-${meetingId}`}>Details <span className="text-red-500">*</span></Label><textarea id={`correction-details-${meetingId}`} rows={4} value={details} aria-invalid={Boolean(errors.details)} aria-describedby={errors.details ? `details-error-${meetingId}` : undefined} onChange={(event) => setDetails(event.target.value)} className="flex min-h-24 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2" />{errors.details && <p id={`details-error-${meetingId}`} role="alert" className="text-xs text-red-600">{errors.details}</p>}</div>
        </div>
        <DialogFooter><Button type="button" variant="outline" onClick={close} disabled={loading}>Cancel</Button><Button type="button" onClick={submit} disabled={loading} className="bg-[#006747] hover:bg-[#00563b]">{loading ? "Saving…" : "Add Correction"}</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  </>;
}
