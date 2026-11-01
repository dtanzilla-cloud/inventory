// Reads Adeline packing slips from positioned PDF text. Has no dependencies, so it can be
// tested outside the Edge Function. It only reports what the slip says; matching against
// products and customers happens in rows.js.

// Some PDFs store each word as its own text item, so nearby items are joined back together.
function joinNearbyItems(items) {
  const joined = [];
  for (const item of items) {
    const last = joined[joined.length - 1];
    if (last && item.x - last.right <= 4) {
      last.text = `${last.text} ${item.text}`;
      last.right = item.right;
    } else {
      joined.push({ ...item });
    }
  }
  return joined.map(({ text, x }) => ({ text, x }));
}

export function groupIntoLines(textItems) {
  const byY = new Map();
  for (const item of textItems) {
    const text = String(item.str ?? "").trim();
    if (!text) continue;
    const y = Math.round(item.transform[5]);
    const x = Math.round(item.transform[4]);
    let bucketY = y;
    for (const existingY of byY.keys()) {
      if (Math.abs(existingY - y) <= 3) { bucketY = existingY; break; }
    }
    if (!byY.has(bucketY)) byY.set(bucketY, []);
    byY.get(bucketY).push({ text, x, right: x + (item.width || 0) });
  }
  return [...byY.entries()]
    .sort((a, b) => b[0] - a[0])
    .map(([y, items]) => ({ y, items: joinNearbyItems(items.sort((a, b) => a.x - b.x)) }));
}

const squeeze = (text) => text.replace(/\s+/g, " ").trim();

function findLine(lines, matcher) {
  return lines.findIndex((line) => line.items.some((item) => matcher(squeeze(item.text))));
}

function labelCell(line, label) {
  // A label can share a joined item with its neighbours, as in "Ship Date Due Date".
  for (const item of line.items) {
    if (squeeze(item.text) === label) return item;
  }
  return null;
}

function valueBelow(lines, label) {
  const index = findLine(lines, (text) => text === label);
  if (index === -1) return "";
  const cell = labelCell(lines[index], label);
  for (let offset = 1; offset <= 4; offset += 1) {
    const line = lines[index + offset];
    if (!line) break;
    const near = line.items
      .filter((item) => Math.abs(item.x - cell.x) <= 40)
      .sort((a, b) => Math.abs(a.x - cell.x) - Math.abs(b.x - cell.x));
    if (near.length) return squeeze(near[0].text);
  }
  return "";
}

function toIsoDate(value) {
  const match = String(value).replace(/\s/g, "").match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!match) return "";
  return `${match[3]}-${match[1].padStart(2, "0")}-${match[2].padStart(2, "0")}`;
}

function firstNumber(value) {
  const match = String(value).replace(/,/g, "").match(/\d+(\.\d+)?/);
  return match ? Number(match[0]) : null;
}

// "4 pallets, 16 drums" states both counts and "16 drums" only pieces. Anything else, such as
// "25 kg cartons" or "1 2 boxes", is not a count this code can trust.
export function parsePacking(text) {
  const value = squeeze(text).toLowerCase();
  const both = value.match(/^(\d+)\s*pal\w*\s*[,;.]?\s*(\d+)\s*[a-z ]+$/);
  if (both) return { pallets: Number(both[1]), pieces: Number(both[2]) };
  const container = value.match(/^\d+\s*fcl\s*[,;]?\s*(\d+)\s*[a-z ]+$/);
  if (container) return { pallets: null, pieces: Number(container[1]) };
  const single = value.match(/^(\d+)\s*(?!kg\b|lb\b|lbs\b|pal)[a-z]+( [a-z]+)?$/);
  if (single) return { pallets: null, pieces: Number(single[1]) };
  return null;
}

// Item text mixes the name with details: "Cetyl Alcohol PO 100139151-3 Lot 25A64B0616".
export function parseItemText(text) {
  const value = squeeze(text);
  const lot = value.match(/\bLot\s*#?\s*:?\s*([A-Za-z0-9][\w./-]*(?:\s*-\s*\d+)?)/i);
  const po = value.match(/\bPO\s*#?\s*:?\s*(\S*\d\S*)/i);
  const nameEnd = value.search(/\s(?:Item\s*#|Lot\b|PO\s*#?\s*:?\s*\S*\d)/i);
  const rawName = squeeze(nameEnd === -1 ? value : value.slice(0, nameEnd));
  return {
    name: squeeze(rawName.replace(/(\.\.\.|…)$/, "")),
    truncated: /(\.\.\.|…)$/.test(rawName),
    lot: lot ? lot[1].replace(/\s/g, "") : "",
    po: po ? po[1] : "",
  };
}

function splitIntoColumns(line, columns) {
  const cells = {};
  for (const item of line.items) {
    // An item belongs to the last header starting at or before it, so a long name stays in Item.
    const column = columns.reduce((best, candidate) =>
      item.x >= candidate.x - 8 && (!best || candidate.x > best.x) ? candidate : best, null) || columns[0];
    cells[column.key] = cells[column.key] ? `${cells[column.key]} ${item.text}` : item.text;
  }
  return cells;
}

function readItems(lines, problems) {
  const headerIndex = findLine(lines, (text) => /^Item\b/.test(text));
  if (headerIndex === -1) {
    problems.push("No item table");
    return [];
  }

  const columns = [];
  for (const cell of lines[headerIndex].items) {
    const text = squeeze(cell.text);
    if (/^Item\b/.test(text)) columns.push({ key: "item", x: cell.x });
    else if (/^Shipped/i.test(text)) columns.push({ key: "shipped", x: cell.x });
    else if (/^Qty in PO/i.test(text)) columns.push({ key: "qty", x: cell.x });
    else if (/^Packing/i.test(text)) columns.push({ key: "packing", x: cell.x - 10 });
  }
  if (!columns.some((column) => column.key === "packing")) problems.push("No Packing column");

  const items = [];
  for (let index = headerIndex + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.items.some((item) => /^Phone\b/.test(squeeze(item.text)))) break;
    const cells = splitIntoColumns(line, columns);
    if (cells.item && (cells.shipped || cells.packing)) {
      items.push({ text: cells.item, shipped_lb: firstNumber(cells.shipped), packing: cells.packing || "" });
    } else if (items.length) {
      // Wrapped text from the row above.
      const last = items[items.length - 1];
      if (cells.item) last.text = `${last.text} ${cells.item}`;
      if (cells.packing) last.packing = `${last.packing} ${cells.packing}`;
    }
  }
  if (!items.length) problems.push("No items found");

  return items.map((item) => ({ ...item, ...parseItemText(item.text), counts: parsePacking(item.packing) }));
}

function readCustomer(lines) {
  const nameIndex = findLine(lines, (text) => text === "Name / Address");
  if (nameIndex !== -1) return squeeze(lines[nameIndex + 1]?.items[0]?.text || "");
  // Slips without a billing block only have Ship To.
  const shipIndex = findLine(lines, (text) => text === "Ship To");
  return shipIndex === -1 ? "" : squeeze(lines[shipIndex + 1]?.items[0]?.text || "");
}

export function parsePackingSlip(lines) {
  const problems = [];
  if (findLine(lines, (text) => /packing slip/i.test(text)) === -1) problems.push("Not a packing slip");

  const items = readItems(lines, problems);
  const shipDate = toIsoDate(valueBelow(lines, "Ship Date"));
  if (!shipDate) problems.push("No Ship Date");

  return {
    customer: readCustomer(lines),
    ship_date: shipDate,
    po: valueBelow(lines, "P.O. No."),
    so: valueBelow(lines, "S.O. No."),
    items,
    problems,
  };
}
