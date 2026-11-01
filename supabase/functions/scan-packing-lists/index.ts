// Scheduled scan: finds new PL*.pdf files in the Purchase Orders folder and queues draft rows
// for review on the app's Packing Lists page. It never writes to the activities table.
import { createClient } from "npm:@supabase/supabase-js@2";
import { downloadFile, getAccessToken, getDriveId, listFolders, listPackingListFiles, pathUnderRoot } from "./drive.js";
import { groupIntoLines, parsePackingSlip } from "./parser.js";
import { buildDraft } from "./rows.js";

const ROOT_FOLDER_ID = "1ojwBP-Ahw3CI7SuDUvzIvq4hHHbKpIPi";
// Free plan functions have little CPU time per run, so each run reads only a few PDFs.
const MAX_PDFS_PER_RUN = 3;
const FIRST_READ_REASON = "This PDF could not be read automatically";

const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

async function selectAll(table: string, columns: string) {
  const rows: any[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase.from(table).select(columns).range(from, from + 999);
    if (error) throw new Error(`${table}: ${error.message}`);
    rows.push(...(data ?? []));
    if (!data || data.length < 1000) return rows;
  }
}

async function upsertEntries(entries: Record<string, unknown>[]) {
  for (let start = 0; start < entries.length; start += 500) {
    const { error } = await supabase
      .from("packing_list_queue")
      .upsert(entries.slice(start, start + 500), { onConflict: "drive_file_id" });
    if (error) throw new Error(`packing_list_queue: ${error.message}`);
  }
}

function entryFor(file: any, path: string, status: string, extra: Record<string, unknown> = {}) {
  return {
    drive_file_id: file.id,
    file_name: file.name,
    file_path: path,
    web_view_link: file.webViewLink ?? "",
    md5: file.md5Checksum ?? "",
    drive_modified_at: file.modifiedTime,
    status,
    ...extra,
  };
}

async function readSlip(bytes: Uint8Array) {
  const { getDocumentProxy } = await import("npm:unpdf@1.4.0");
  const pdf = await getDocumentProxy(bytes);
  const lines = [];
  for (let number = 1; number <= pdf.numPages; number += 1) {
    const page = await pdf.getPage(number);
    lines.push(...groupIntoLines((await page.getTextContent()).items));
  }
  return parsePackingSlip(lines);
}

async function scan() {
  const token = await getAccessToken(
    JSON.parse(Deno.env.get("GOOGLE_SERVICE_ACCOUNT_JSON")!),
    Deno.env.get("GOOGLE_DRIVE_USER")!,
  );
  const driveId = await getDriveId(ROOT_FOLDER_ID, token);
  const files = await listPackingListFiles(driveId, token);
  const known = await selectAll("packing_list_queue", "drive_file_id, md5, status");
  const knownById = new Map(known.map((entry) => [entry.drive_file_id, entry]));

  // The first run records what already exists, so only files added later reach the queue.
  if (!known.length) {
    if (!files.length) throw new Error("No PL PDFs are visible. Check the Google Drive user and delegation settings.");
    const folders = await listFolders(driveId, token);
    const baseline = [];
    for (const file of files) {
      const path = pathUnderRoot(file, ROOT_FOLDER_ID, folders);
      if (path !== null) baseline.push(entryFor(file, path, "baseline"));
    }
    if (!baseline.length) throw new Error("No PL PDFs were found in the Purchase Orders folder.");
    await upsertEntries(baseline);
    return { baseline: baseline.length };
  }

  const toRead = files
    .filter((file) => {
      const entry = knownById.get(file.id);
      return !entry || (file.md5Checksum && entry.md5 !== file.md5Checksum);
    })
    .sort((a, b) => a.createdTime.localeCompare(b.createdTime));

  if (!toRead.length) return { visible: files.length, waiting: 0, queued: 0, copies: 0 };

  const folders = await listFolders(driveId, token);
  const md5s = new Set(known.filter((entry) => entry.md5).map((entry) => entry.md5));
  let queued = 0;
  let copies = 0;
  let outside = 0;
  let products: any[] = [];
  let customers: any[] = [];
  let warehouses: any[] = [];
  let activities: any[] = [];

  for (const file of toRead) {
    if (queued >= MAX_PDFS_PER_RUN) break;
    const path = pathUnderRoot(file, ROOT_FOLDER_ID, folders);
    if (path === null) {
      outside += 1;
      continue;
    }
    const previous = knownById.get(file.id);

    // The same PDF saved in a second folder is recorded but not reviewed twice.
    if (!previous && file.md5Checksum && md5s.has(file.md5Checksum)) {
      await upsertEntries([entryFor(file, path, "duplicate")]);
      copies += 1;
      continue;
    }

    // Saved before reading, so a PDF that crashes the reader still reaches the review list.
    const changedReason = previous ? ["This file changed after it was first scanned, so earlier rows may need correcting"] : [];
    await upsertEntries([entryFor(file, path, "pending", { reasons: [FIRST_READ_REASON, ...changedReason], draft: null })]);
    if (file.md5Checksum) md5s.add(file.md5Checksum);
    queued += 1;

    if (!activities.length) {
      products = (await selectAll("products", "name, active")).filter((product) => product.active !== false);
      customers = (await selectAll("customers", "name, active")).filter((customer) => customer.active !== false);
      warehouses = (await selectAll("warehouses", "id, code, name, active")).filter((warehouse) => warehouse.active);
      activities = await selectAll("activities", "activity_date, warehouse_id, pallets, pieces, product, note");
    }

    try {
      const slip = await readSlip(await downloadFile(file.id, token));
      const draft = buildDraft(slip, file.name, {
        products, customers, warehouses, activities, today: new Date().toISOString().slice(0, 10),
      });
      await upsertEntries([entryFor(file, path, "pending", { reasons: [...changedReason, ...draft.reasons], draft })]);
    } catch (error) {
      console.error(file.id, error);
    }
  }

  return { visible: files.length, waiting: toRead.length - queued - copies - outside, queued, copies };
}

Deno.serve(async (request) => {
  const secret = Deno.env.get("SCAN_SECRET");
  if (!secret || request.headers.get("x-scan-secret") !== secret) {
    return new Response("Forbidden", { status: 403 });
  }
  try {
    return Response.json(await scan());
  } catch (error) {
    console.error(error);
    return Response.json({ error: String(error) }, { status: 500 });
  }
});
