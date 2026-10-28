import { createBrowserClient } from "@supabase/ssr";
import { supabasePublishableKey, supabaseUrl } from "./env";

// Browser client: only used to start sign-in. It cannot read questions (RLS).
export const supabaseBrowser = () => createBrowserClient(supabaseUrl, supabasePublishableKey);
