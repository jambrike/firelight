export const onRequestGet = ({ env }) => {
  const config = {
    supabaseUrl: env.SUPABASE_URL || "",
    supabaseAnonKey: env.SUPABASE_ANON_KEY || ""
  };

  return new Response(`window.FIRELIGHT_CONFIG = ${JSON.stringify(config)};`, {
    headers: {
      "content-type": "application/javascript; charset=utf-8",
      "cache-control": "no-store"
    }
  });
};
