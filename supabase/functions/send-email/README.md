# send-email Edge Function

Sends transactional invite emails via Resend.

## Deploy

```bash
supabase functions deploy send-email
supabase functions deploy create-user
```

## Required secrets

Set these in Supabase Dashboard → Project Settings → Edge Functions → Secrets,
or via the CLI:

```bash
supabase secrets set RESEND_API_KEY=re_...
supabase secrets set FROM_EMAIL=noreply@yourdomain.com
supabase secrets set APP_URL=https://yourorg.github.io/event-manager
supabase secrets set SUPABASE_SERVICE_ROLE_KEY=eyJ...   # for create-user function
```

`SUPABASE_URL` and `SUPABASE_ANON_KEY` are automatically available inside Edge Functions.

## Local development

```bash
supabase start
supabase functions serve send-email --env-file .env.local
```

`.env.local` should contain the secrets above (never commit this file).

## Test curl

```bash
# Get a manager JWT first from the browser devtools (Application → Local Storage → sb-*-auth-token)
TOKEN="eyJ..."

curl -X POST http://localhost:54321/functions/v1/send-email \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "type": "invite_attendee",
    "to": "test@example.com",
    "tempPassword": "abc123",
    "eventName": "Test Event",
    "attendeeName": "Test User",
    "qrToken": "aabbccddeeff00112233445566778899"
  }'
```

## Email types

| type | Description |
|---|---|
| `invite_manager` | Invites a new manager with temp password |
| `invite_taker` | Invites an attendance taker with event/period context |
| `invite_attendee` | Invites an attendee and embeds their QR code |
| `resend_invite` | Resends any invite with a refreshed temp password |
