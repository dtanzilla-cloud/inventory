import React, { useMemo, useState, useEffect } from "react";
import { motion } from "framer-motion";
import { Search, Plus, Trash2, Upload, FileText, Settings, Warehouse, Activity, DollarSign, Users, ChevronDown } from "lucide-react";
import { supabase } from './supabaseClient'

const warehouses = ["All", "Warehouse A", "Warehouse B", "Warehouse C", "Warehouse D", "Warehouse E"];
const users = ["Adeline (Owner)", "Warehouse A", "Warehouse B", "Warehouse C", "Warehouse D", "Warehouse E"];

const initialActivities = [
  { id: 1, date: "2025-09-02", warehouse: "Warehouse A", pallets: 32, pieces: 768, product: "Stearic Acid", customer: "", lot: "", supplier: "PT. Dua Kuda Indonesia", repack: "", note: "", docs: [] },
  { id: 2, date: "2025-09-18", warehouse: "Warehouse A", pallets: 3, pieces: 12, product: "Sorbitol 70% nc", customer: "", lot: "", supplier: "Agridient Inc.", repack: "", note: "", docs: [] },
  { id: 3, date: "2025-10-07", warehouse: "Warehouse B", pallets: 0, pieces: -10, product: "Cocoa Butter", customer: "Bradford Soap Works, Inc.", lot: "", supplier: "", repack: "Y", note: "Outbound/repack", docs: [] },
  { id: 4, date: "2025-12-22", warehouse: "Warehouse A", pallets: 32, pieces: 800, product: "Stearic Acid", customer: "", lot: "", supplier: "", repack: "", note: "Inbound", docs: [] },
  { id: 5, date: "2025-12-11", warehouse: "Warehouse C", pallets: -5, pieces: -120, product: "Stearic Acid 1895", customer: "", lot: "", supplier: "", repack: "", note: "Outbound", docs: [] },
];

const initialInventory = [
  { item: "Stearic Acid", warehouse: "Warehouse A", in: 40, reserved: 5, incoming: 32 },
  { item: "Sorbitol 70% nc", warehouse: "Warehouse A", in: 1, reserved: 0, incoming: 0 },
  { item: "Triclosan USP", warehouse: "Warehouse B", in: 2, reserved: 0, incoming: 0 },
  { item: "Cocoa Butter", warehouse: "Warehouse B", in: 2, reserved: 1, incoming: 0 },
  { item: "Refined glycerin", warehouse: "Warehouse C", in: 50, reserved: 8, incoming: 0 },
  { item: "Cocoa Butter Deodorized", warehouse: "Warehouse B", in: 2, reserved: 1, incoming: 0 },
  { item: "Zinc Oxide USP", warehouse: "Warehouse D", in: 22, reserved: 0, incoming: 0 },
  { item: "Stearic Acid 1895", warehouse: "Warehouse C", in: 35, reserved: 5, incoming: 0 },
];

const chargeMonths = {
  "December 2025": {
    storageRate: 6,
    inboundRate: 10,
    outboundRate: 10,
    storageSubtotal: 1260,
    inboundSubtotal: 370,
    outboundSubtotal: 160,
    total: 1790,
    invoices: ["24202.pdf", "24201.pdf"],
    weekly: [
      ["Dec 1 – Dec 7", 34, 204],
      ["Dec 8 – Dec 14", 31, 186],
      ["Dec 15 – Dec 21", 27, 162],
      ["Dec 22 – Dec 28", 59, 354],
      ["Dec 29 – Dec 31", 59, 354],
    ],
    inbound: [
      ["Dec 5", "grapeseed-oil", "Grapeseed Oil", 1, 10],
      ["Dec 9", "hfe-347", "HFE-347", 3, 30],
      ["Dec 22", "stearic-acid", "Stearic Acid", 32, 320],
      ["Dec 22", "mct-oil-organic-certified", "MCT Oil organic certified", 1, 10],
    ],
    outbound: [
      ["Dec 1", "refined-glycerin", "Refined glycerin", 4, 40],
      ["Dec 5", "refined-glycerin", "Refined glycerin", 4, 40],
      ["Dec 11", "hfe-347", "HFE-347", 2, 20],
      ["Dec 11", "stearic-acid-1895", "Stearic Acid 1895", 5, 50],
      ["Dec 18", "hfe-347", "HFE-347", 1, 10],
    ],
  },
};

function money(n) { return n.toLocaleString(undefined, { style: "currency", currency: "USD" }); }

export default function InventoryManagementSystem() {
  console.log("SUPABASE:", supabase)
  const [section, setSection] = useState("Activities");
  const [warehouse, setWarehouse] = useState("All");
  const [activities, setActivities] = useState([]);
  const [query, setQuery] = useState("");
  const [month, setMonth] = useState("December 2025");
  const [draft, setDraft] = useState({ date: "2025-12-31", warehouse: "Warehouse A", pallets: 0, pieces: 0, product: "", customer: "", lot: "", supplier: "", repack: "", note: "", docs: [] });

  useEffect(() => {
  loadActivities()
  }, [])

  async function loadActivities() {
    const { data, error } = await supabase
      .from('activities')
      .select('*')
      .order('activity_date', { ascending: false })

    if (error) {
      console.error(error)
    } else {
      setActivities(data || [])
    }
  }

  const visibleActivities = activities.filter(a =>
    (warehouse === "All" || a.warehouse === warehouse) &&
    JSON.stringify(a).toLowerCase().includes(query.toLowerCase())
  );

  const visibleInventory = useMemo(() => initialInventory.filter(i => warehouse === "All" || i.warehouse === warehouse), [warehouse]);
  const totals = visibleInventory.reduce((acc, r) => ({ in: acc.in + r.in, reserved: acc.reserved + r.reserved, incoming: acc.incoming + r.incoming }), { in: 0, reserved: 0, incoming: 0 });
  const charges = chargeMonths[month];

  async function addEvent() {

  if (!draft.product) return;

  const payload = {
    activity_date: draft.date,
    warehouse: draft.warehouse,
    pallets: Number(draft.pallets),
    pieces: Number(draft.pieces),
    product: draft.product,
    customer: draft.customer,
    lot_number: draft.lot,
    supplier: draft.supplier,
    repack: draft.repack,
    note: draft.note
  }

  const { error } = await supabase
    .from('activities')
    .insert([payload])

  if (error) {
    console.error(error)
    alert("Insert failed")
    return
  }

  await loadActivities()

  setDraft({
    date: "2025-12-31",
    warehouse: "Warehouse A",
    pallets: 0,
    pieces: 0,
    product: "",
    customer: "",
    lot: "",
    supplier: "",
    repack: "",
    note: "",
    docs: []
  })
}

  function attachDoc(id, fileList) {
    const files = Array.from(fileList || []).map(f => f.name);
    setActivities(activities.map(a => a.id === id ? { ...a, docs: [...a.docs, ...files] } : a));
  }

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      <div className="flex">
        <aside className="w-72 min-h-screen bg-white border-r border-slate-200 p-5 sticky top-0">
          <div className="mb-8">
            <div className="text-xl font-bold">Adeline Inventory</div>
            <div className="text-sm text-slate-500">Online warehouse portal</div>
          </div>

          <NavButton icon={<Activity size={18}/>} active={section === "Activities"} onClick={() => setSection("Activities")}>Activities</NavButton>

          <div className="mt-4 mb-2 text-xs font-semibold text-slate-400 uppercase">Inventory</div>
          {warehouses.map(w => <NavButton key={w} icon={<Warehouse size={18}/>} active={section === "Inventory" && warehouse === w} onClick={() => { setSection("Inventory"); setWarehouse(w); }}>{w}</NavButton>)}

          <div className="mt-4 mb-2 text-xs font-semibold text-slate-400 uppercase">Charges</div>
          {Object.keys(chargeMonths).map(m => <NavButton key={m} icon={<DollarSign size={18}/>} active={section === "Charges" && month === m} onClick={() => { setSection("Charges"); setMonth(m); }}>{m}</NavButton>)}

          <div className="mt-4 mb-2 text-xs font-semibold text-slate-400 uppercase">Settings</div>
          <NavButton icon={<Settings size={18}/>} active={section === "Settings"} onClick={() => setSection("Settings")}>Users</NavButton>
        </aside>

        <main className="flex-1 p-8">
          <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}>
            {section === "Activities" && <ActivitiesView {...{visibleActivities, query, setQuery, draft, setDraft, addEvent, setActivities, activities, attachDoc}} />}
            {section === "Inventory" && <InventoryView warehouse={warehouse} rows={visibleInventory} totals={totals} />}
            {section === "Charges" && <ChargesView month={month} charges={charges} />}
            {section === "Settings" && <SettingsView />}
          </motion.div>
        </main>
      </div>
    </div>
  );
}

function NavButton({ icon, active, children, onClick }) {
  return <button onClick={onClick} className={`w-full flex items-center gap-3 px-3 py-2 rounded-xl text-sm mb-1 transition ${active ? "bg-slate-900 text-white" : "hover:bg-slate-100 text-slate-700"}`}>{icon}<span>{children}</span></button>;
}

function KPI({ label, value }) {
  return <Card className="rounded-2xl shadow-sm"><CardContent className="p-5"><div className="text-sm text-slate-500">{label}</div><div className="text-2xl font-bold mt-1">{value}</div></CardContent></Card>;
}

function ActivitiesView({ visibleActivities, query, setQuery, draft, setDraft, addEvent, setActivities, activities, attachDoc }) {
  return <>
    <Header title="Activities" subtitle="Inbound, outbound, repack, notes, and documents per event." />
    <Card className="rounded-2xl shadow-sm mb-6"><CardContent className="p-5">
      <div className="grid grid-cols-6 gap-3">
        <Input label="Date" type="date" value={draft.date} onChange={v => setDraft({...draft, date:v})}/>
        <Select label="Warehouse" value={draft.warehouse} onChange={v => setDraft({...draft, warehouse:v})} options={warehouses.slice(1)}/>
        <Input label="Activity/pallet" type="number" value={draft.pallets} onChange={v => setDraft({...draft, pallets:v})}/>
        <Input label="Piece count" type="number" value={draft.pieces} onChange={v => setDraft({...draft, pieces:v})}/>
        <Input label="Product" value={draft.product} onChange={v => setDraft({...draft, product:v})}/>
        <Input label="Customer" value={draft.customer} onChange={v => setDraft({...draft, customer:v})}/>
        <Input label="Lot number" value={draft.lot} onChange={v => setDraft({...draft, lot:v})}/>
        <Input label="Supplier" value={draft.supplier} onChange={v => setDraft({...draft, supplier:v})}/>
        <Input label="Repack?" value={draft.repack} onChange={v => setDraft({...draft, repack:v})}/>
        <Input label="Note" value={draft.note} onChange={v => setDraft({...draft, note:v})}/>
        <div className="col-span-2 flex items-end"><Button onClick={addEvent} className="w-full rounded-xl"><Plus size={16} className="mr-2"/>Add event</Button></div>
      </div>
    </CardContent></Card>

    <div className="flex items-center gap-3 mb-4">
      <div className="relative flex-1"><Search size={18} className="absolute left-3 top-3 text-slate-400"/><input className="w-full pl-10 pr-3 py-2 rounded-xl border bg-white" placeholder="Search activities..." value={query} onChange={e=>setQuery(e.target.value)}/></div>
    </div>

    <Table headers={["Date", "Whse", "Pallet", "Pieces", "Product", "Customer", "Supplier", "Docs", ""]} rows={visibleActivities.map(a => [a.date, a.warehouse, a.pallets, a.pieces, a.product, a.customer || "—", a.supplier || "—", <DocUpload key={a.id} docs={a.docs} onChange={files => attachDoc(a.id, files)}/>, <Button key="del" size="sm" variant="ghost" onClick={() => setActivities(activities.filter(x => x.id !== a.id))}><Trash2 size={16}/></Button>])}/>
  </>;
}

function InventoryView({ warehouse, rows, totals }) {
  return <>
    <Header title={`Inventory — ${warehouse}`} subtitle="In = inventory up to yesterday; Reserved = future outbound; Incoming = future inbound." />
    <div className="grid grid-cols-3 gap-4 mb-6"><KPI label="In" value={totals.in}/><KPI label="Reserved" value={totals.reserved}/><KPI label="Incoming" value={totals.incoming}/></div>
    <Table headers={["Item", "Warehouse", "In", "Reserved", "Incoming", "Available"]} rows={rows.map(r => [r.item, r.warehouse, r.in, r.reserved, r.incoming, r.in - r.reserved])}/>
  </>;
}

function ChargesView({ month, charges }) {
  return <>
    <Header title={`Charges — ${month}`} subtitle="Storage, inbound handling, outbound handling, invoices, and charge details." />
    <div className="grid grid-cols-4 gap-4 mb-6"><KPI label="Storage" value={money(charges.storageSubtotal)}/><KPI label="Inbound" value={money(charges.inboundSubtotal)}/><KPI label="Outbound" value={money(charges.outboundSubtotal)}/><KPI label="Total" value={money(charges.total)}/></div>
    <div className="grid grid-cols-3 gap-6 mb-6">
      <Card className="rounded-2xl shadow-sm"><CardContent className="p-5"><h3 className="font-semibold mb-2">Billing Rates</h3><Rate label="Storage" value={`${money(charges.storageRate)} / unit / week`}/><Rate label="Inbound" value={`${money(charges.inboundRate)} / HU`}/><Rate label="Outbound" value={`${money(charges.outboundRate)} / HU`}/><Button variant="outline" className="mt-4 rounded-xl">Edit rates</Button></CardContent></Card>
      <Card className="rounded-2xl shadow-sm col-span-2"><CardContent className="p-5"><h3 className="font-semibold mb-2 flex items-center gap-2"><FileText size={18}/>Invoices</h3>{charges.invoices.map(i => <div key={i} className="flex justify-between border-b py-3"><span>{i}</span><span className="text-green-700 font-medium">PAID</span></div>)}<Button variant="outline" className="mt-4 rounded-xl"><Upload size={16} className="mr-2"/>Attach PDF invoice</Button></CardContent></Card>
    </div>
    <SectionTable title="Weekly Storage Breakdown" headers={["Period", "Units on hand", "Rate", "Charge"]} rows={charges.weekly.map(w => [w[0], w[1], money(charges.storageRate), money(w[2])])}/>
    <SectionTable title="Inbound Movements" headers={["Date", "SKU", "Description", "HU", "Charge"]} rows={charges.inbound.map(r => [r[0], r[1], r[2], r[3], money(r[4])])}/>
    <SectionTable title="Outbound Movements" headers={["Date", "SKU", "Description", "HU", "Charge"]} rows={charges.outbound.map(r => [r[0], r[1], r[2], r[3], money(r[4])])}/>
  </>;
}

function SettingsView() {
  return <>
    <Header title="Settings — Users" subtitle="Owner and warehouse-level user access." />
    <Card className="rounded-2xl shadow-sm"><CardContent className="p-5"><Table headers={["User", "Role", "Access"]} rows={users.map((u, i) => [u, i === 0 ? "Owner" : "Warehouse user", i === 0 ? "All warehouses + charges + settings" : `${u} activities and inventory only`])}/></CardContent></Card>
  </>;
}

function Header({ title, subtitle }) { return <div className="mb-6"><h1 className="text-3xl font-bold tracking-tight">{title}</h1><p className="text-slate-500 mt-1">{subtitle}</p></div>; }
function Rate({ label, value }) { return <div className="flex justify-between py-2 border-b"><span className="text-slate-500">{label}</span><span className="font-semibold">{value}</span></div>; }
function Input({ label, value, onChange, type="text" }) { return <label className="text-xs font-medium text-slate-500"><span>{label}</span><input type={type} className="mt-1 w-full px-3 py-2 border rounded-xl bg-white text-sm" value={value} onChange={e=>onChange(e.target.value)}/></label>; }
function Select({ label, value, onChange, options }) { return <label className="text-xs font-medium text-slate-500"><span>{label}</span><select className="mt-1 w-full px-3 py-2 border rounded-xl bg-white text-sm" value={value} onChange={e=>onChange(e.target.value)}>{options.map(o=><option key={o}>{o}</option>)}</select></label>; }

function DocUpload({ docs = [], onChange }) {
  return (
    <div>
      <label className="inline-flex items-center gap-1 text-xs cursor-pointer text-slate-700">
        <Upload size={14} />
        Upload
        <input
          type="file"
          multiple
          className="hidden"
          onChange={e => onChange(e.target.files)}
        />
      </label>

      <div className="text-xs text-slate-500 mt-1">
        {docs.length ? docs.join(", ") : "—"}
      </div>
    </div>
  );
}

function SectionTable({ title, headers, rows }) { return <div className="mb-6"><h3 className="font-semibold mb-2">{title}</h3><Table headers={headers} rows={rows}/></div>; }
function Table({ headers, rows }) { return <div className="overflow-hidden rounded-2xl border bg-white shadow-sm"><table className="w-full text-sm"><thead className="bg-slate-100 text-slate-600"><tr>{headers.map(h => <th key={h} className="text-left px-4 py-3 font-semibold">{h}</th>)}</tr></thead><tbody>{rows.map((r, idx) => <tr key={idx} className="border-t hover:bg-slate-50">{r.map((c, i) => <td key={i} className="px-4 py-3 align-top">{c}</td>)}</tr>)}</tbody></table></div>; }

function Card({ children, className = "" }) {
  return <div className={className}>{children}</div>;
}

function CardContent({ children, className = "" }) {
  return <div className={className}>{children}</div>;
}

function Button({
  children,
  className = "",
  variant = "default",
  size = "default",
  ...props
}) {
  const base =
    "inline-flex items-center justify-center px-4 py-2 rounded-xl text-sm font-medium transition";

  const variants = {
    default: "bg-slate-900 text-white hover:bg-slate-700",
    outline: "border border-slate-300 bg-white hover:bg-slate-100",
    ghost: "hover:bg-slate-100",
  };

  const sizes = {
    default: "",
    sm: "px-2 py-1 text-xs",
  };

  return (
    <button
      className={`${base} ${variants[variant]} ${sizes[size]} ${className}`}
      {...props}
    >
      {children}
    </button>
  );
}