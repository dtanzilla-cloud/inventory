// Minimal read-only Google Drive client. The service account acts as a company user, because
// the shared drive does not allow sharing with accounts outside the company.

const DRIVE = "https://www.googleapis.com/drive/v3/files";
const SHARED_DRIVE_PARAMS = "supportsAllDrives=true&includeItemsFromAllDrives=true";

function base64Url(value) {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : new Uint8Array(value);
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function getAccessToken(serviceAccount, userEmail) {
  const now = Math.floor(Date.now() / 1000);
  const unsigned = `${base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${base64Url(JSON.stringify({
    iss: serviceAccount.client_email,
    sub: userEmail,
    scope: "https://www.googleapis.com/auth/drive.readonly",
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  }))}`;

  const pem = serviceAccount.private_key.replace(/-----[^-]+-----/g, "").replace(/\s/g, "");
  const key = await crypto.subtle.importKey(
    "pkcs8",
    Uint8Array.from(atob(pem), (character) => character.charCodeAt(0)),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(unsigned));

  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: `${unsigned}.${base64Url(signature)}`,
    }),
  });
  if (!response.ok) throw new Error(`Google sign-in failed: ${response.status}`);
  return (await response.json()).access_token;
}

// Google's 5xx and rate limit errors are usually temporary, so these are tried again.
async function driveFetch(url, token, action) {
  for (let attempt = 1; ; attempt += 1) {
    const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (response.ok) return response;
    if (attempt < 3 && (response.status >= 500 || response.status === 429)) {
      await new Promise((resolve) => setTimeout(resolve, attempt * 1000));
      continue;
    }
    const detail = (await response.text()).replace(/\s+/g, " ").slice(0, 300);
    const error = new Error(`Google Drive failed to ${action}: ${response.status} ${detail}`);
    error.status = response.status;
    throw error;
  }
}

async function driveJson(url, token, action) {
  return (await driveFetch(url, token, action)).json();
}

export async function getDriveId(rootId, token) {
  const root = await driveJson(`${DRIVE}/${rootId}?supportsAllDrives=true&fields=driveId`, token, "open the Purchase Orders folder");
  if (!root.driveId) throw new Error("The Purchase Orders folder is not in a shared drive.");
  return root.driveId;
}

async function listDriveItems(driveId, driveQuery, itemFields, token, action) {
  const items = [];
  const query = encodeURIComponent(`${driveQuery} and trashed=false`);
  const fields = encodeURIComponent(`nextPageToken,files(${itemFields})`);
  let pageToken = "";
  do {
    const page = await driveJson(
      `${DRIVE}?q=${query}&corpora=drive&driveId=${driveId}&${SHARED_DRIVE_PARAMS}&pageSize=200&fields=${fields}${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ""}`,
      token,
      action,
    );
    items.push(...page.files);
    pageToken = page.nextPageToken || "";
  } while (pageToken);
  return items;
}

// Drive's search also matches PL at the start of later words, so names are checked here too.
export async function listPackingListFiles(driveId, token) {
  const files = await listDriveItems(
    driveId,
    "mimeType='application/pdf' and name contains 'PL'",
    "id,name,md5Checksum,modifiedTime,createdTime,webViewLink,parents",
    token,
    "list PDFs",
  );
  return files.filter((file) => /^pl/i.test(file.name));
}

// All folders in one listing, which is far quicker than looking up each one in turn.
export async function listFolders(driveId, token) {
  const folders = await listDriveItems(driveId, "mimeType='application/vnd.google-apps.folder'", "id,name,parents", token, "list folders");
  return new Map(folders.map((folder) => [folder.id, folder]));
}

// Returns the folder path below rootId, or null when the file is outside that folder.
export function pathUnderRoot(file, rootId, folders) {
  const names = [];
  let parentId = file.parents?.[0];
  while (parentId) {
    if (parentId === rootId) return names.reverse().join("/");
    const folder = folders.get(parentId);
    if (!folder) return null;
    names.push(folder.name);
    parentId = folder.parents?.[0];
  }
  return null;
}

export async function downloadFile(fileId, token) {
  const response = await driveFetch(`${DRIVE}/${fileId}?alt=media&supportsAllDrives=true`, token, "download a PDF");
  return new Uint8Array(await response.arrayBuffer());
}
