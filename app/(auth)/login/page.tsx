"use client";

import { GraduationCap } from "lucide-react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { toast } from "sonner";

import { loginSchema, type LoginFormValues } from "@/lib/validators/auth";
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

/**
 * Login page — email/password form with RHF + Zod validation.
 *
 * The `handleSignIn` function is a placeholder; replace with a real
 * Supabase auth call once the integration is ready.
 */
export default function LoginPage() {
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<LoginFormValues>({
    resolver: zodResolver(loginSchema),
  });

  async function handleSignIn(data: LoginFormValues) {
    // TODO: replace with real Supabase auth
    // const { error } = await supabaseBrowserClient.auth.signInWithPassword({
    //   email: data.email,
    //   password: data.password,
    // });

    // Simulate a short network delay for demonstration purposes
    await new Promise((resolve) => setTimeout(resolve, 800));

    toast.success(`Signed in as ${data.email}`, {
      description: "Redirecting to dashboard…",
    });

    // TODO: router.push("/dashboard") after real auth
    console.log("[OCF] Sign in placeholder — data:", data);
  }

  return (
    <Card className="w-full max-w-sm">
      <CardHeader className="space-y-3 pb-4">
        {/* Logo mark */}
        <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-primary">
          <GraduationCap className="h-6 w-6 text-primary-foreground" />
        </div>

        <div>
          <CardTitle className="text-xl">Sign in to OCF</CardTitle>
          <CardDescription className="mt-1">
            FGCU Office of Competitive Fellowships
          </CardDescription>
        </div>
      </CardHeader>

      <form onSubmit={handleSubmit(handleSignIn)} noValidate>
        <CardContent className="space-y-4">
          {/* Email */}
          <div className="space-y-1.5">
            <Label htmlFor="email">Email address</Label>
            <Input
              id="email"
              type="email"
              autoComplete="email"
              placeholder="you@fgcu.edu"
              aria-invalid={!!errors.email}
              {...register("email")}
            />
            {errors.email && (
              <p className="text-xs text-destructive" role="alert">
                {errors.email.message}
              </p>
            )}
          </div>

          {/* Password */}
          <div className="space-y-1.5">
            <Label htmlFor="password">Password</Label>
            <Input
              id="password"
              type="password"
              autoComplete="current-password"
              placeholder="••••••••"
              aria-invalid={!!errors.password}
              {...register("password")}
            />
            {errors.password && (
              <p className="text-xs text-destructive" role="alert">
                {errors.password.message}
              </p>
            )}
          </div>
        </CardContent>

        <CardFooter className="flex flex-col gap-3">
          <Button type="submit" className="w-full" disabled={isSubmitting}>
            {isSubmitting ? "Signing in…" : "Sign in"}
          </Button>
          <p className="text-center text-xs text-muted-foreground">
            Need access? Contact your OCF administrator.
          </p>
        </CardFooter>
      </form>
    </Card>
  );
}
