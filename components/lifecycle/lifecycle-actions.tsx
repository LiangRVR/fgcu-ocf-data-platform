"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Archive, ArchiveRestore, ShieldOff, ShieldCheck } from "lucide-react";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { supabaseBrowserClient } from "@/lib/supabase/client";
import { toast } from "sonner";

/**
 * LifecycleAction
 *
 * The single client-side entry point for every confirmed lifecycle transition
 * a normal advisor can perform from the UI:
 *
 *   - Archive / Restore   a Student or Fellowship   (soft, reversible)
 *   - Deactivate / Reactivate an Advisor             (active ↔ inactive)
 *
 * Wording and iconography follow the AI-DLC design intent:
 *   - destructive lifecycle verbs ("Archive Student", "Archive Fellowship",
 *     "Deactivate Advisor") for the off-ramp,
 *   - recovery verbs ("Restore Student", "Restore Fellowship",
 *     "Reactivate Advisor") for the on-ramp,
 *   - confirmation dialogs for every transition (no silent off-ramps),
 *   - the same RPC the design owns (`public.lifecycle_transition`), so the
 *     trusted-administrator boundary (Auth app_metadata.ocf_admin=true) and
 *     the self-deactivation guard are the only authoritative source.
 *
 * After every successful transition, the surrounding route is refreshed so
 * server loaders re-resolve archive state and child workflow surfaces re-gate.
 *
 * This component is intentionally generic. The caller decides whether the
 * operator is allowed to see it (e.g. advisor detail only renders
 * `Deactivate Advisor` / `Reactivate Advisor` for trusted OCF admins).
 */

export type LifecycleEntity = "student" | "fellowship" | "advisor";
export type LifecycleActionName =
  | "archive"
  | "restore"
  | "deactivate"
  | "reactivate";

interface LifecycleActionProps {
  entity: LifecycleEntity;
  entityId: number;
  /** Display label for the target (e.g. "Ada Lovelace"). Shown in the dialog. */
  entityLabel: string;
  /**
   * The action this trigger performs. Drives wording, icon, and which RPC
   * verb is invoked.
   */
  action: LifecycleActionName;
  /** Visual variant for the trigger button. */
  variant?: "default" | "outline" | "ghost";
  size?: "sm" | "default" | "icon";
  /**
   * Render the trigger as an icon-only button (hides the label, keeps the
   * action name as the aria-label). Use when the trigger sits in a dense
   * actions cell next to other icon buttons.
   */
  iconOnly?: boolean;
  /**
   * Stop the trigger click from bubbling to a parent row-click handler.
   * Required when the trigger is rendered inside a clickable row that
   * navigates on click. Defaults to true (the row case is the common one;
   * standalone triggers can opt out via `propagateClick`).
   */
  stopPropagation?: boolean;
  className?: string;
}

/**
 * Stable dialog copy per (entity, action). Wording is locked to the exact
 * lifecycle verbs the design says we must use: "Archive Student", "Archive
 * Fellowship", "Deactivate Advisor", plus their restore / reactivate mirrors.
 */
const COPY: Record<
  LifecycleEntity,
  Record<LifecycleActionName, { title: string; confirm: string; body: string }>
> = {
  student: {
    archive: {
      title: "Archive Student",
      confirm: "Archive Student",
      body:
        "Archiving removes this student from active workflows (new applications, advising). " +
        "Existing applications, advising meetings, and scholarship history are preserved and continue to display the student's name.",
    },
    restore: {
      title: "Restore Student",
      confirm: "Restore Student",
      body:
        "Restoring returns this student to active workflows. Existing applications, advising meetings, and scholarship history remain intact.",
    },
    deactivate: {
      title: "Archive Student",
      confirm: "Archive Student",
      body:
        "This action is not available for students. Use Archive Student instead.",
    },
    reactivate: {
      title: "Restore Student",
      confirm: "Restore Student",
      body:
        "This action is not available for students. Use Restore Student instead.",
    },
  },
  fellowship: {
    archive: {
      title: "Archive Fellowship",
      confirm: "Archive Fellowship",
      body:
        "Archiving removes this fellowship from active workflows (new applications). " +
        "Existing applications and scholarship history are preserved and continue to display the fellowship name.",
    },
    restore: {
      title: "Restore Fellowship",
      confirm: "Restore Fellowship",
      body:
        "Restoring returns this fellowship to active workflows. Existing applications and scholarship history remain intact.",
    },
    deactivate: {
      title: "Archive Fellowship",
      confirm: "Archive Fellowship",
      body:
        "This action is not available for fellowships. Use Archive Fellowship instead.",
    },
    reactivate: {
      title: "Restore Fellowship",
      confirm: "Restore Fellowship",
      body:
        "This action is not available for fellowships. Use Restore Fellowship instead.",
    },
  },
  advisor: {
    archive: {
      title: "Archive Student",
      confirm: "Archive Student",
      body:
        "This action is not available for advisors. Use Deactivate Advisor instead.",
    },
    restore: {
      title: "Restore Student",
      confirm: "Restore Student",
      body:
        "This action is not available for advisors. Use Reactivate Advisor instead.",
    },
    deactivate: {
      title: "Deactivate Advisor",
      confirm: "Deactivate Advisor",
      body:
        "Deactivating immediately blocks this advisor from signing in, while preserving every meeting and amendment attribution. " +
        "An administrator cannot deactivate their own active account — another administrator must perform this action.",
    },
    reactivate: {
      title: "Reactivate Advisor",
      confirm: "Reactivate Advisor",
      body:
        "Reactivating restores this advisor's sign-in access. Past meetings and amendments remain attributed.",
    },
  },
};

function TriggerLabel({
  entity,
  action,
}: {
  entity: LifecycleEntity;
  action: LifecycleActionName;
}) {
  if (entity === "advisor") {
    return action === "deactivate" ? "Deactivate Advisor" : "Reactivate Advisor";
  }
  return action === "archive" ? `Archive ${labelFor(entity)}` : `Restore ${labelFor(entity)}`;
}

function labelFor(entity: LifecycleEntity): string {
  if (entity === "student") return "Student";
  if (entity === "fellowship") return "Fellowship";
  return "Advisor";
}

function TriggerIcon({
  entity,
  action,
  iconClass,
}: {
  entity: LifecycleEntity;
  action: LifecycleActionName;
  iconClass?: string;
}) {
  if (entity === "advisor") {
    return action === "deactivate" ? (
      <ShieldOff className={iconClass ?? "mr-2 h-4 w-4"} />
    ) : (
      <ShieldCheck className={iconClass ?? "mr-2 h-4 w-4"} />
    );
  }
  return action === "archive" ? (
    <Archive className={iconClass ?? "mr-2 h-4 w-4"} />
  ) : (
    <ArchiveRestore className={iconClass ?? "mr-2 h-4 w-4"} />
  );
}

/**
 * Maps a (entity, action) pair to the lifecycle RPC parameters. Cross-axis
 * combinations (e.g. deactivating a student) are blocked at the type level by
 * this component, but the runtime guard below is the fail-closed safety net.
 */
function resolveRpcParams(
  entity: LifecycleEntity,
  action: LifecycleActionName,
): { p_entity: LifecycleEntity; p_action: LifecycleActionName } | null {
  if (entity === "advisor") {
    if (action === "deactivate" || action === "reactivate") {
      return { p_entity: "advisor", p_action: action };
    }
    return null;
  }
  if (action === "archive" || action === "restore") {
    return { p_entity: entity, p_action: action };
  }
  return null;
}

export function LifecycleAction({
  entity,
  entityId,
  entityLabel,
  action,
  variant,
  size = "sm",
  iconOnly = false,
  stopPropagation = true,
  className,
}: LifecycleActionProps) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [isAdmin, setIsAdmin] = useState(false);
  const [isPending, startTransition] = useTransition();

  useEffect(() => {
    let alive = true;
    supabaseBrowserClient.auth.getSession().then(({ data }) => {
      if (alive) setIsAdmin(data.session?.user.app_metadata?.ocf_admin === true);
    });
    return () => { alive = false; };
  }, []);

  // Lifecycle controls are admin-only affordances. Server/RLS remains authoritative.
  if (!isAdmin) return null;

  const copy = COPY[entity][action];

  // Default variant: archive / deactivate are the off-ramp (default),
  // restore / reactivate are the on-ramp (outline).
  const resolvedVariant: "default" | "outline" | "ghost" =
    variant ??
    (action === "archive" || action === "deactivate" ? "outline" : "outline");

  const handleConfirm = () => {
    const params = resolveRpcParams(entity, action);
    if (!params) {
      // Cross-axis call. Fail closed with a visible toast.
      toast.error("That lifecycle action is not supported for this entity.");
      setOpen(false);
      return;
    }
    startTransition(async () => {
      const { error } = await supabaseBrowserClient.rpc("lifecycle_transition", {
        p_entity: params.p_entity,
        p_action: params.p_action,
        p_entity_id: entityId,
      });
      if (error) {
        toast.error(error.message ?? "Lifecycle transition failed.");
        return;
      }
      const successWord =
        action === "archive"
          ? "Archived"
          : action === "restore"
            ? "Restored"
            : action === "deactivate"
              ? "Deactivated"
              : "Reactivated";
      toast.success(`${successWord} ${entityLabel}`);
      setOpen(false);
      router.refresh();
    });
  };

  // In iconOnly mode, the button keeps a square hit area and renders only the
  // icon; the full action label is preserved as the aria-label so assistive
  // tech still announces the verb + entity.
  const effectiveSize = iconOnly ? "icon" : size;
  const iconWrapClass = iconOnly ? "" : "mr-2 h-4 w-4";

  return (
    <>
      <Button
        type="button"
        variant={resolvedVariant}
        size={effectiveSize}
        onClick={(event) => {
          if (stopPropagation) event.stopPropagation();
          setOpen(true);
        }}
        className={className}
        aria-label={copy.confirm}
      >
        <TriggerIcon entity={entity} action={action} iconClass={iconWrapClass} />
        {iconOnly ? null : <TriggerLabel entity={entity} action={action} />}
      </Button>

      <AlertDialog
        open={open}
        onOpenChange={(nextOpen) => {
          if (!isPending) setOpen(nextOpen);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{copy.title}</AlertDialogTitle>
            <AlertDialogDescription>
              {copy.body}{" "}
              <span className="font-medium text-slate-700">
                ({entityLabel})
              </span>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(event) => {
                // The action button must not auto-close before the RPC runs
                // (Radix would otherwise close on activation). We close it
                // ourselves after the transition settles.
                event.preventDefault();
                handleConfirm();
              }}
              disabled={isPending}
              className={
                action === "archive" || action === "deactivate"
                  ? "bg-amber-600 text-white hover:bg-amber-700"
                  : "bg-emerald-600 text-white hover:bg-emerald-700"
              }
            >
              {isPending ? "Working…" : copy.confirm}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
