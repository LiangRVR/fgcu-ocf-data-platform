"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { GraduationCap, Loader2, ShieldCheck } from "lucide-react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { toast } from "sonner";
import { supabaseBrowserClient } from "@/lib/supabase/client";
import {
  passwordUpdateSchema,
  type PasswordUpdateValues,
} from "@/lib/validators/account";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

export function ResetPasswordForm() {
  const router = useRouter();
  const [hasRecoverySession, setHasRecoverySession] = useState(false);
  const [isCheckingSession, setIsCheckingSession] = useState(true);
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<PasswordUpdateValues>({
    resolver: zodResolver(passwordUpdateSchema),
  });

  useEffect(() => {
    let isMounted = true;

    supabaseBrowserClient.auth.getUser().then(({ data: { user } }) => {
      if (isMounted && user) {
        setHasRecoverySession(true);
      }
      if (isMounted) setIsCheckingSession(false);
    });

    const {
      data: { subscription },
    } = supabaseBrowserClient.auth.onAuthStateChange((event, session) => {
      if (event === "PASSWORD_RECOVERY" || !!session?.user) {
        setHasRecoverySession(true);
      }
      if (isMounted) setIsCheckingSession(false);
    });

    return () => {
      isMounted = false;
      subscription.unsubscribe();
    };
  }, []);

  async function handleResetPassword(values: PasswordUpdateValues) {
    const { error } = await supabaseBrowserClient.auth.updateUser({
      password: values.newPassword,
    });

    if (error) {
      toast.error("Password reset failed", {
        description: error.message,
      });
      return;
    }

    toast.success("Password updated", {
      description: "Sign in with your new password.",
    });

    router.replace("/login");
    router.refresh();
  }

  return (
    <Card className="w-full max-w-sm">
      <CardHeader className="space-y-3 pb-4">
        <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-primary">
          <GraduationCap className="h-6 w-6 text-primary-foreground" />
        </div>

        <div>
          <CardTitle className="text-xl">Create a new password</CardTitle>
          <CardDescription className="mt-1">
            Finish the recovery flow by setting a strong new password.
          </CardDescription>
        </div>
      </CardHeader>

      {isCheckingSession ? (
        <CardContent className="flex items-center justify-center py-8">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </CardContent>
      ) : (
        <form onSubmit={handleSubmit(handleResetPassword)} noValidate>
        <CardContent className="space-y-4">
          <div className="rounded-md border border-blue-200 bg-blue-50 px-3 py-2 text-sm text-blue-900">
            {hasRecoverySession
              ? "Your recovery session is active. Set a new password below."
              : "Open this page from the password reset email so Supabase can attach your recovery session."}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="newPassword">New password</Label>
            <div className="relative">
              <ShieldCheck className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
              <Input
                id="newPassword"
                type="password"
                autoComplete="new-password"
                placeholder="Minimum 10 characters"
                aria-invalid={!!errors.newPassword}
                className="pl-9"
                {...register("newPassword")}
              />
            </div>
            {errors.newPassword && (
              <p className="text-xs text-destructive" role="alert">
                {errors.newPassword.message}
              </p>
            )}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="confirmPassword">Confirm password</Label>
            <Input
              id="confirmPassword"
              type="password"
              autoComplete="new-password"
              placeholder="Re-enter your new password"
              aria-invalid={!!errors.confirmPassword}
              {...register("confirmPassword")}
            />
            {errors.confirmPassword && (
              <p className="text-xs text-destructive" role="alert">
                {errors.confirmPassword.message}
              </p>
            )}
          </div>
        </CardContent>

        <CardFooter className="flex flex-col gap-3">
          <Button type="submit" className="w-full" disabled={isSubmitting || !hasRecoverySession}>
            {isSubmitting ? "Updating password..." : "Update password"}
          </Button>
          <Link href="/login" className="text-xs font-medium text-primary hover:underline">
            Back to sign in
          </Link>
        </CardFooter>
      </form>
      )}
    </Card>
  );
}
