import { NextResponse, type NextRequest } from "next/server";
import type { EmailOtpType } from "@supabase/supabase-js";
import { supabaseServer } from "@/lib/supabase/server";

// OAuth (Google) and magic-link redirects land here.
export async function GET(request: NextRequest) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");
  const tokenHash = searchParams.get("token_hash");
  const type = searchParams.get("type") as EmailOtpType | null;
  const supabase = await supabaseServer();

  if (code) await supabase.auth.exchangeCodeForSession(code);
  else if (tokenHash && type) await supabase.auth.verifyOtp({ token_hash: tokenHash, type });

  return NextResponse.redirect(`${origin}/`);
}
