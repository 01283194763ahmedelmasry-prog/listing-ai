# Setup
1. Supabase project: run schema.sql; Auth > Providers: enable Google and Facebook (add their OAuth client IDs); Auth > URL config: add the site URL.
2. Host (Render web service, start command `npm start`): set env vars from .env (GEMINI_API_KEY, SUPABASE_*, ADMIN_TOKEN).
3. Activate a paid user after verifying payment:
   curl -X POST $SITE/api/admin/activate -d '{"token":"ADMIN_TOKEN","email":"user@x.com","plan":"monthly"}'
