"use client";

import Link from "next/link";
import { GraduationCap, Mail } from "lucide-react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { toast } from "sonner";
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
import {
  forgotPasswordSchema,
  type ForgotPasswordValues,
} from "@/lib/validators/account";

export function ForgotPasswordForm() {
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
    reset,
  } = useForm<ForgotPasswordValues>({
    resolver: zodResolver(forgotPasswordSchema),
  });

  async function handleForgotPassword(values: ForgotPasswordValues) {
    const response = await fetch("/api/auth/forgot-password", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(values),
    });

    const payload = (await response.json().catch(() => null)) as
      | { error?: string }
      | null;

    if (!response.ok) {
      toast.error("Unable to send reset email", {
        description: payload?.error ?? "Please try again.",
      });
      return;
    }

    reset();
    toast.success("Password reset email sent", {
      description: "Check your inbox for a secure reset link.",
    });
  }

  return (
    <Card className="w-full max-w-sm">
      <CardHeader className="space-y-3 pb-4">
        <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-primary">
          <GraduationCap className="h-6 w-6 text-primary-foreground" />
        </div>

        <div>
          <CardTitle className="text-xl">Reset your password</CardTitle>
          <CardDescription className="mt-1">
            Enter your FGCU email and we will send you a recovery link.
          </CardDescription>
        </div>
      </CardHeader>

      <form onSubmit={handleSubmit(handleForgotPassword)} noValidate>
        <CardContent className="space-y-4">
          <div className="rounded-md border border-blue-200 bg-blue-50 px-3 py-2 text-sm text-blue-900">
            Use this only if you cannot sign in. Logged-in advisors can change their password from the account page.
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="email">Email address</Label>
            <div className="relative">
              <Mail className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
              <Input
                id="email"
                type="email"
                autoComplete="email"
                placeholder="you@fgcu.edu"
                aria-invalid={!!errors.email}
                className="pl-9"
                {...register("email")}
              />
            </div>
            {errors.email && (
              <p className="text-xs text-destructive" role="alert">
                {errors.email.message}
              </p>
            )}
          </div>
        </CardContent>

        <CardFooter className="flex flex-col gap-3">
          <Button type="submit" className="w-full" disabled={isSubmitting}>
            {isSubmitting ? "Sending reset link..." : "Send reset link"}
          </Button>
          <Link href="/login" className="text-xs font-medium text-primary hover:underline">
            Back to sign in
          </Link>
        </CardFooter>
      </form>
    </Card>
  );
}
