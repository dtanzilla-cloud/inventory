# Packing list scan

Every 15 minutes this function looks for new `PL*.pdf` files in the Purchase Orders Drive folder and subfolders. It reads up to 3 per run and queues draft rows on the app's **Packing Lists** page. It never writes to `activities`; rows are added only when an owner clicks **Add to Activities**.

The first run records every existing PL PDF as already handled, so only files added later appear in the queue.

## Setup

Replace `YOUR-PROJECT-REF` below with the ID in your Supabase dashboard URL (`supabase.com/dashboard/project/YOUR-PROJECT-REF`).

### 1. Create the database table

In Supabase, open **SQL Editor** and run `supabase/migrations/20261101120000_add_packing_list_queue.sql`.

### 2. Create the Google service account

1. In [Google Cloud Console](https://console.cloud.google.com/), create a project and enable the **Google Drive API**.
2. Under **IAM & Admin > Service Accounts**, create a service account. It needs no project roles.
3. On its **Keys** tab, choose **Add key > Create new key > JSON** and download the file. Treat it like a password and don't put it in this repo.
4. On the service account's **Details** tab, copy its **Unique ID**, a long number.
5. A Google Workspace admin opens [admin.google.com](https://admin.google.com/) and goes to **Security > Access and data control > API controls > Manage Domain Wide Delegation**. Click **Add new**, paste the Unique ID, enter this scope, and click **Authorize**:

   ```text
   https://www.googleapis.com/auth/drive.readonly
   ```

6. Choose the company user the scan acts as. That user needs access to Purchase Orders. The key can read everything in that user's Drive, so a dedicated user with access to only this shared drive is safest. The function ignores files outside Purchase Orders.

### 3. Add the secrets

Create a long random value for `SCAN_SECRET` and save it for steps 5 and 6. In **Edge Functions > Secrets**, add:

| Name | Value |
|---|---|
| `GOOGLE_SERVICE_ACCOUNT_JSON` | The full contents of the downloaded JSON file |
| `GOOGLE_DRIVE_USER` | The email of the company user from step 2 |
| `SCAN_SECRET` | The random value |

### 4. Deploy the function

From the project folder:

```bash
npx supabase login
```

```bash
npx supabase functions deploy scan-packing-lists --project-ref YOUR-PROJECT-REF --no-verify-jwt
```

`--no-verify-jwt` is needed because the scheduler has no user login. `SCAN_SECRET` protects the function instead.

### 5. Run it once

```bash
curl -i -X POST https://YOUR-PROJECT-REF.supabase.co/functions/v1/scan-packing-lists -H "x-scan-secret: YOUR-SCAN-SECRET"
```

The first run should return `{"baseline":<count>}`. Run it again and expect `"queued":0`.

### 6. Schedule it

In **SQL Editor**, replace the two placeholders and run:

```sql
create extension if not exists pg_cron;
create extension if not exists pg_net;

select vault.create_secret('YOUR-SCAN-SECRET', 'scan_packing_lists_secret');

select cron.schedule(
  'scan-packing-lists',
  '*/15 * * * *',
  $$
  select net.http_post(
    url := 'https://YOUR-PROJECT-REF.supabase.co/functions/v1/scan-packing-lists',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-scan-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'scan_packing_lists_secret')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 140000
  );
  $$
);
```

### 7. Turn off the local scan

Disable **Scan PL packing lists into Activities** in the Claude app's Scheduled section, so it can't add rows that are also in the queue.

## Checking on it

- **Function logs:** Edge Functions > scan-packing-lists > Logs.
- **Scheduler runs:** `select * from cron.job_run_details order by start_time desc limit 10;`
- **Pause it:** `select cron.unschedule('scan-packing-lists');`

## Limits

- Free plan projects can pause after about a week of inactivity, which stops the scan until the project is restored.
- A PDF that can't be read still appears on the page, with a note to check it by hand.
- Draft dates come from the slip's Ship Date. Existing rows are usually dated later, so check the date before adding.
