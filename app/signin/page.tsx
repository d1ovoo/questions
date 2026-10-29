import { supabasePublishableKey, supabaseUrl } from "@/lib/supabase/env";
import { SignInForm } from "./form";

// Only offer Google when it's switched on in Supabase; otherwise the button leads to an
// "Unsupported provider" error page.
async function googleEnabled(): Promise<boolean> {
  try {
    const res = await fetch(`${supabaseUrl}/auth/v1/settings`, {
      headers: { apikey: supabasePublishableKey },
      next: { revalidate: 300 },
    });
    const settings = (await res.json()) as { external?: { google?: boolean } };
    return settings.external?.google === true;
  } catch {
    return false;
  }
}

export default async function SignIn({ searchParams }: PageProps<"/signin">) {
  const { error } = await searchParams;
  return <SignInForm googleEnabled={await googleEnabled()} linkFailed={error === "link"} />;
}
