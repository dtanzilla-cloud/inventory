// Turns a parsed packing slip into draft activity rows for a person to review. Every item gets
// a row, with blanks where the slip or the master data leave a value unclear.

const normalize = (text) => String(text ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

function customerKey(name) {
  return normalize(name)
    .replace(/^the (original )?/, "")
    .replace(/\b(inc|llc|ltd|corp|corporation|co|company|incorporated)\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function matchCustomer(slipName, customers) {
  const key = customerKey(slipName);
  if (!key) return "";
  const exact = customers.filter((customer) => customerKey(customer.name) === key);
  if (exact.length === 1) return exact[0].name;
  const partial = customers.filter((customer) => {
    const other = customerKey(customer.name);
    return other && (other.startsWith(`${key} `) || key.startsWith(`${other} `));
  });
  return partial.length === 1 ? partial[0].name : "";
}

// Only an exact name, or a cut-off name fitting exactly one product, counts as a match.
function matchProduct(item, products) {
  const key = normalize(item.name);
  if (!key) return "";
  const matches = item.truncated
    ? products.filter((product) => normalize(product.name).startsWith(key))
    : products.filter((product) => normalize(product.name) === key);
  return matches.length === 1 ? matches[0].name : "";
}

function matchWarehouse(item, product, activities, warehouses, today) {
  const suffix = item.text.match(/-\s*(IN|CT)\b/);
  if (suffix) {
    const wanted = suffix[1] === "IN" ? "INNOUT" : "CTS";
    return warehouses.find((warehouse) => warehouse.code === wanted) || null;
  }
  if (!product) return null;
  const cutoff = new Date(today);
  cutoff.setDate(cutoff.getDate() - 90);
  const since = cutoff.toISOString().slice(0, 10);
  const recent = new Set(activities
    .filter((row) => row.product === product && row.activity_date >= since && row.warehouse_id)
    .map((row) => row.warehouse_id));
  if (recent.size !== 1) return null;
  const [id] = recent;
  return warehouses.find((warehouse) => warehouse.id === id) || null;
}

// Most slips do not state pallets, so this uses the same product's past pieces per pallet.
function estimatePallets(pieces, product, warehouseId, activities) {
  const past = activities.filter((row) =>
    row.product === product && row.warehouse_id === warehouseId && Number(row.pallets) && Number(row.pieces));
  if (!past.length) return null;
  const ratios = past.map((row) => Math.abs(Number(row.pieces) / Number(row.pallets))).sort((a, b) => a - b);
  return Math.round(pieces / ratios[Math.floor(ratios.length / 2)]);
}

export function poFromFileName(fileName) {
  // "_" counts as a word character, so \b would miss the PO in PL_Bradford_PO 123.
  const match = fileName.replace(/\.pdf$/i, "").match(/(?:^|[^a-z0-9])PO[ _]+(.+)$/i);
  return match ? match[1].trim() : "";
}

function resolvePo(slip, item, fileName) {
  // A PO on the item line wins over the slip's, which can just say "see below".
  const slipPo = /^see below$/i.test(slip.po) ? "" : slip.po.replace(/^PO\s*/i, "").trim();
  const fromSlip = item.po || slipPo;
  const fromName = poFromFileName(fileName);
  if (fromSlip && fromName) {
    // The file name can carry a shipment suffix: 100138600-1 is part of PO 100138600.
    const agree = fromName === fromSlip || fromName.startsWith(`${fromSlip}-`) || fromName.startsWith(`${fromSlip}_`);
    return agree
      ? { po: fromName }
      : { po: fromSlip, problem: `PO on the slip (${fromSlip}) differs from the file name (${fromName})` };
  }
  return fromSlip || fromName ? { po: fromSlip || fromName } : { po: "", problem: "No PO number found" };
}

export function buildDraft(slip, fileName, { products, customers, warehouses, activities, today }) {
  const reasons = [...slip.problems];
  if (/(rev|upd|correct)/i.test(poFromFileName(fileName) || fileName)) {
    reasons.push("The file name says this is a revision, so it may replace an earlier slip");
  }

  const customer = matchCustomer(slip.customer, customers);
  if (!customer) reasons.push(`Customer not matched: ${slip.customer || "none on the slip"}`);

  const rows = slip.items.map((item) => {
    const product = matchProduct(item, products);
    if (!product) reasons.push(`Product not matched: ${item.text}`);

    if (!item.counts) reasons.push(`Packing not understood: ${item.packing || "blank"} (${item.name || item.text})`);
    const pieces = item.counts ? item.counts.pieces : null;

    const { po, problem } = resolvePo(slip, item, fileName);
    if (problem) reasons.push(problem);

    const warehouse = matchWarehouse(item, product, activities, warehouses, today);
    if (product && !warehouse) reasons.push(`Choose a warehouse for ${product}`);

    let pallets = item.counts ? item.counts.pallets : null;
    const palletsEstimated = pallets === null && pieces !== null && Boolean(product && warehouse);
    if (palletsEstimated) pallets = estimatePallets(pieces, product, warehouse.id, activities);
    if (pallets === null) reasons.push(`Enter pallets for ${product || item.name || item.text}`);

    if (product && po && activities.some((row) => row.product === product && normalize(row.note).includes(normalize(po)))) {
      reasons.push(`A ${product} row already mentions PO ${po}, so this may be a duplicate`);
    }

    return {
      activity_date: slip.ship_date,
      warehouse: warehouse?.name || "",
      warehouse_id: warehouse?.id || "",
      pallets: pallets === null ? "" : pallets === 0 ? 0 : -pallets,
      pieces: pieces === null ? "" : -pieces,
      product,
      customer,
      lot_number: item.lot,
      expiration_date: null,
      supplier: "",
      repack: "",
      note: po ? `PO ${po}` : "",
      pdf_text: item.text,
      pdf_packing: item.packing,
      pallets_estimated: palletsEstimated && pallets !== null,
    };
  });

  return { rows, reasons: [...new Set(reasons)], slip_customer: slip.customer };
}
