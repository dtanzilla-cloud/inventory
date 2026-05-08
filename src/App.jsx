import { useMemo, useState, useEffect } from "react";
import { motion } from "framer-motion";
import {
  Search,
  Plus,
  Trash2,
  Upload,
  FileText,
  Settings,
  Warehouse,
  Activity,
  DollarSign,
  Save,
} from "lucide-react";
import { supabase } from "./supabaseClient";

const ALL_WAREHOUSES = "All";
const DEFAULT_WAREHOUSE = { id: null, code: "WH-A", name: "Warehouse A", active: true };
const emptyDraft = {
  activity_date: new Date().toISOString().slice(0, 10),
  warehouse_id: "",
  warehouse: DEFAULT_WAREHOUSE.name,
  pallets: 0,
  pieces: 0,
  product: "",
  customer: "",
  lot_number: "",
  supplier: "",
  repack: "",
  note: "",
  docs: [],
};

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
      ["Dec 1 - Dec 7", 34, 204],
      ["Dec 8 - Dec 14", 31, 186],
      ["Dec 15 - Dec 21", 27, 162],
      ["Dec 22 - Dec 28", 59, 354],
      ["Dec 29 - Dec 31", 59, 354],
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

function money(n) {
  return n.toLocaleString(undefined, { style: "currency", currency: "USD" });
}

function warehouseLabel(warehouse) {
  if (!warehouse) return "";
  return warehouse.code ? `${warehouse.name} (${warehouse.code})` : warehouse.name;
}

function getActivityWarehouseName(activity) {
  return activity.warehouse_name || activity.warehouse || "Unassigned";
}

function normalizeWarehouse(warehouse) {
  return {
    id: warehouse.id,
    code: warehouse.code || "",
    name: warehouse.name || "",
    active: warehouse.active !== false,
    created_at: warehouse.created_at,
  };
}

function normalizeProfile(profile) {
  return {
    ...profile,
    role: profile?.role || "owner",
    warehouse_id: profile?.warehouse_id || "",
    warehouse_name: profile?.warehouses?.name || profile?.warehouse || "",
  };
}

function normalizeActivity(activity) {
  return {
    ...activity,
    activity_date: activity.activity_date || activity.date || "",
    docs: Array.isArray(activity.docs) ? activity.docs : [],
    warehouse_id: activity.warehouse_id || "",
    warehouse_name: activity.warehouses?.name || activity.warehouse || "",
    warehouse_code: activity.warehouses?.code || "",
  };
}

function createDraftForWarehouse(warehouse) {
  const selectedWarehouse = warehouse || DEFAULT_WAREHOUSE;

  return {
    ...emptyDraft,
    warehouse_id: selectedWarehouse.id || "",
    warehouse: selectedWarehouse.name,
  };
}

function deriveInventoryRows(activities) {
  const today = new Date().toISOString().slice(0, 10);
  const grouped = new Map();

  activities.forEach((activity) => {
    const warehouseName = getActivityWarehouseName(activity);
    const warehouseKey = activity.warehouse_id || warehouseName;
    if (!activity.product || !warehouseKey || !activity.activity_date) return;

    const key = `${activity.product}::${warehouseKey}`;
    const current = grouped.get(key) || {
      item: activity.product,
      warehouse_id: activity.warehouse_id || "",
      warehouse: warehouseName,
      in_qty: 0,
      reserved_qty: 0,
      incoming_qty: 0,
    };
    const pieces = Number(activity.pieces) || 0;

    if (activity.activity_date < today) {
      current.in_qty += pieces;
    } else if (pieces < 0) {
      current.reserved_qty += Math.abs(pieces);
    } else if (pieces > 0) {
      current.incoming_qty += pieces;
    }

    grouped.set(key, current);
  });

  return Array.from(grouped.values()).sort((a, b) => {
    const byWarehouse = a.warehouse.localeCompare(b.warehouse);
    return byWarehouse || a.item.localeCompare(b.item);
  });
}

export default function InventoryManagementSystem() {
  const [section, setSection] = useState("Activities");
  const [settingsTab, setSettingsTab] = useState("Users");
  const [warehouseFilter, setWarehouseFilter] = useState(ALL_WAREHOUSES);
  const [warehouses, setWarehouses] = useState([DEFAULT_WAREHOUSE]);
  const [profile, setProfile] = useState({ role: "owner", warehouse_id: "" });
  const [activities, setActivities] = useState([]);
  const [query, setQuery] = useState("");
  const [month, setMonth] = useState("December 2025");
  const [draft, setDraft] = useState(createDraftForWarehouse(DEFAULT_WAREHOUSE));
  const [loading, setLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState("");

  const isOwner = profile.role === "owner" || profile.role === "admin";
  const activeWarehouses = warehouses.filter((warehouse) => warehouse.active);
  const assignedWarehouse = warehouses.find((warehouse) => warehouse.id === profile.warehouse_id);
  const selectableWarehouses = isOwner ? activeWarehouses : activeWarehouses.filter((warehouse) => warehouse.id === profile.warehouse_id);
  const defaultWarehouse = assignedWarehouse || activeWarehouses[0] || warehouses[0] || DEFAULT_WAREHOUSE;

  useEffect(() => {
    loadInitialData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function loadInitialData() {
    setLoading(true);
    setErrorMessage("");

    const nextProfile = await loadProfile();
    const nextWarehouses = await loadWarehouses();
    const nextIsOwner = nextProfile.role === "owner" || nextProfile.role === "admin";
    const nextAssignedWarehouse = nextWarehouses.find((warehouse) => warehouse.id === nextProfile.warehouse_id);

    if (!nextIsOwner && nextAssignedWarehouse) {
      setWarehouseFilter(nextAssignedWarehouse.id);
      setDraft((current) => ({ ...current, warehouse_id: nextAssignedWarehouse.id, warehouse: nextAssignedWarehouse.name }));
    }

    await loadActivities(nextProfile, nextWarehouses);

    setLoading(false);
  }

  async function loadProfile() {
    const { data: authData } = await supabase.auth.getUser();
    const user = authData?.user;

    if (!user) {
      const ownerProfile = { role: "owner", warehouse_id: "" };
      setProfile(ownerProfile);
      return ownerProfile;
    }

    const { data, error } = await supabase
      .from("profiles")
      .select("id, role, warehouse, warehouse_id, warehouses:warehouse_id(id, code, name)")
      .eq("id", user.id)
      .maybeSingle();

    if (error) {
      console.error(error);
      setErrorMessage("Could not load profile from Supabase.");
      const fallbackProfile = { role: "warehouse", warehouse_id: "" };
      setProfile(fallbackProfile);
      return fallbackProfile;
    }

    const nextProfile = normalizeProfile(data || { id: user.id, role: "owner" });
    setProfile(nextProfile);
    return nextProfile;
  }

  async function loadWarehouses() {
    const { data, error } = await supabase
      .from("warehouses")
      .select("id, code, name, active, created_at")
      .order("name", { ascending: true });

    if (error) {
      console.error(error);
      setErrorMessage("Could not load warehouses from Supabase.");
      setWarehouses([DEFAULT_WAREHOUSE]);
      return [DEFAULT_WAREHOUSE];
    }

    const nextWarehouses = (data || []).map(normalizeWarehouse);
    const safeWarehouses = nextWarehouses.length ? nextWarehouses : [DEFAULT_WAREHOUSE];
    setWarehouses(safeWarehouses);
    setDraft((current) => {
      if (current.warehouse_id || current.warehouse !== DEFAULT_WAREHOUSE.name) return current;
      return createDraftForWarehouse(safeWarehouses.find((warehouse) => warehouse.active) || safeWarehouses[0]);
    });
    return safeWarehouses;
  }

  async function loadActivities(nextProfile = profile, nextWarehouses = warehouses) {
    setErrorMessage("");

    let queryBuilder = supabase
      .from("activities")
      .select("*, warehouses:warehouse_id(id, code, name)")
      .order("activity_date", { ascending: false });

    if (nextProfile.role !== "owner" && nextProfile.role !== "admin") {
      if (nextProfile.warehouse_id) {
        queryBuilder = queryBuilder.eq("warehouse_id", nextProfile.warehouse_id);
      } else if (nextProfile.warehouse_name) {
        queryBuilder = queryBuilder.eq("warehouse", nextProfile.warehouse_name);
      }
    }

    const { data, error } = await queryBuilder;

    if (error) {
      console.error(error);
      setErrorMessage("Could not load activities from Supabase.");
      setActivities([]);
    } else {
      const normalized = (data || []).map(normalizeActivity);
      setActivities(backfillLegacyWarehouseNames(normalized, nextWarehouses));
    }
  }

  function backfillLegacyWarehouseNames(rows, knownWarehouses) {
    const warehousesById = new Map(knownWarehouses.filter((warehouse) => warehouse.id).map((warehouse) => [warehouse.id, warehouse]));

    return rows.map((row) => {
      const linkedWarehouse = warehousesById.get(row.warehouse_id);
      if (!linkedWarehouse) return row;
      return {
        ...row,
        warehouse_name: row.warehouse_name || linkedWarehouse.name,
        warehouse_code: row.warehouse_code || linkedWarehouse.code,
      };
    });
  }

  const visibleActivities = activities.filter((activity) => {
    const matchesWarehouse =
      warehouseFilter === ALL_WAREHOUSES ||
      activity.warehouse_id === warehouseFilter ||
      getActivityWarehouseName(activity) === warehouseFilter;
    const matchesQuery = JSON.stringify(activity).toLowerCase().includes(query.toLowerCase());
    return matchesWarehouse && matchesQuery;
  });

  const inventoryRows = useMemo(() => deriveInventoryRows(activities), [activities]);
  const visibleInventory = useMemo(
    () =>
      inventoryRows.filter(
        (item) => warehouseFilter === ALL_WAREHOUSES || item.warehouse_id === warehouseFilter || item.warehouse === warehouseFilter,
      ),
    [inventoryRows, warehouseFilter],
  );
  const totals = visibleInventory.reduce(
    (acc, row) => ({
      in_qty: acc.in_qty + row.in_qty,
      reserved_qty: acc.reserved_qty + row.reserved_qty,
      incoming_qty: acc.incoming_qty + row.incoming_qty,
    }),
    { in_qty: 0, reserved_qty: 0, incoming_qty: 0 },
  );
  const charges = chargeMonths[month];
  const currentWarehouseLabel =
    warehouseFilter === ALL_WAREHOUSES
      ? ALL_WAREHOUSES
      : warehouses.find((warehouse) => warehouse.id === warehouseFilter)?.name || warehouseFilter;

  async function addEvent() {
    if (!draft.product) return;

    const selectedWarehouse = warehouses.find((warehouse) => warehouse.id === draft.warehouse_id) || defaultWarehouse;
    const payload = {
      activity_date: draft.activity_date,
      warehouse_id: selectedWarehouse.id || null,
      warehouse: selectedWarehouse.name || draft.warehouse,
      pallets: Number(draft.pallets),
      pieces: Number(draft.pieces),
      product: draft.product,
      customer: draft.customer,
      lot_number: draft.lot_number,
      supplier: draft.supplier,
      repack: draft.repack,
      note: draft.note,
    };

    const { error } = await supabase.from("activities").insert([payload]);

    if (error) {
      console.error(error);
      setErrorMessage("Insert failed in Supabase.");
      return;
    }

    await loadActivities();
    setDraft(createDraftForWarehouse(defaultWarehouse));
  }

  async function deleteActivity(id) {
    if (!id) return;

    const { error } = await supabase.from("activities").delete().eq("id", id);

    if (error) {
      console.error(error);
      setErrorMessage("Delete failed in Supabase.");
      return;
    }

    setActivities((current) => current.filter((activity) => activity.id !== id));
  }

  async function saveWarehouse(warehouse) {
    const code = warehouse.code.trim().toUpperCase();
    const name = warehouse.name.trim();

    if (!code || !name) {
      setErrorMessage("Warehouse code and name are required.");
      return;
    }

    const payload = { code, name, active: warehouse.active !== false };
    const request = warehouse.id
      ? supabase.from("warehouses").update(payload).eq("id", warehouse.id)
      : supabase.from("warehouses").insert([payload]);

    const { error } = await request;

    if (error) {
      console.error(error);
      setErrorMessage("Warehouse could not be saved.");
      return;
    }

    const nextWarehouses = await loadWarehouses();
    await loadActivities(profile, nextWarehouses);
  }

  function attachDoc(id, fileList) {
    const files = Array.from(fileList || []).map((file) => file.name);
    setActivities((current) =>
      current.map((activity) => (activity.id === id ? { ...activity, docs: [...activity.docs, ...files] } : activity)),
    );
  }

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      <div className="flex">
        <aside className="sticky top-0 min-h-screen w-72 border-r border-slate-200 bg-white p-5">
          <div className="mb-8">
            <div className="text-xl font-bold">Adeline Inventory</div>
            <div className="text-sm text-slate-500">Online warehouse portal</div>
          </div>

          <NavButton icon={<Activity size={18} />} active={section === "Activities"} onClick={() => setSection("Activities")}>
            Activities
          </NavButton>

          <div className="mt-4 mb-2 text-xs font-semibold uppercase text-slate-400">Inventory</div>
          {isOwner && (
            <NavButton
              icon={<Warehouse size={18} />}
              active={section === "Inventory" && warehouseFilter === ALL_WAREHOUSES}
              onClick={() => {
                setSection("Inventory");
                setWarehouseFilter(ALL_WAREHOUSES);
              }}
            >
              All warehouses
            </NavButton>
          )}
          {selectableWarehouses.map((warehouse) => (
            <NavButton
              key={warehouse.id || warehouse.code}
              icon={<Warehouse size={18} />}
              active={section === "Inventory" && warehouseFilter === warehouse.id}
              onClick={() => {
                setSection("Inventory");
                setWarehouseFilter(warehouse.id);
              }}
            >
              {warehouse.name}
            </NavButton>
          ))}

          <div className="mt-4 mb-2 text-xs font-semibold uppercase text-slate-400">Charges</div>
          {Object.keys(chargeMonths).map((chargeMonth) => (
            <NavButton
              key={chargeMonth}
              icon={<DollarSign size={18} />}
              active={section === "Charges" && month === chargeMonth}
              onClick={() => {
                setSection("Charges");
                setMonth(chargeMonth);
              }}
            >
              {chargeMonth}
            </NavButton>
          ))}

          {isOwner && (
            <>
              <div className="mt-4 mb-2 text-xs font-semibold uppercase text-slate-400">Settings</div>
              <NavButton icon={<Settings size={18} />} active={section === "Settings"} onClick={() => setSection("Settings")}>
                Settings
              </NavButton>
            </>
          )}
        </aside>

        <main className="flex-1 p-8">
          <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}>
            {errorMessage && <div className="mb-4 rounded border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{errorMessage}</div>}
            {section === "Activities" && (
              <ActivitiesView
                {...{
                  visibleActivities,
                  query,
                  setQuery,
                  draft,
                  setDraft,
                  addEvent,
                  deleteActivity,
                  attachDoc,
                  loading,
                  warehouses: selectableWarehouses,
                  isOwner,
                }}
              />
            )}
            {section === "Inventory" && <InventoryView warehouse={currentWarehouseLabel} rows={visibleInventory} totals={totals} />}
            {section === "Charges" && <ChargesView month={month} charges={charges} />}
            {section === "Settings" && isOwner && (
              <SettingsView
                warehouses={warehouses}
                settingsTab={settingsTab}
                setSettingsTab={setSettingsTab}
                saveWarehouse={saveWarehouse}
                profile={profile}
              />
            )}
          </motion.div>
        </main>
      </div>
    </div>
  );
}

function NavButton({ icon, active, children, onClick }) {
  return (
    <button
      onClick={onClick}
      className={`mb-1 flex w-full items-center gap-3 rounded px-3 py-2 text-sm transition ${
        active ? "bg-slate-900 text-white" : "text-slate-700 hover:bg-slate-100"
      }`}
    >
      {icon}
      <span>{children}</span>
    </button>
  );
}

function KPI({ label, value }) {
  return (
    <Card className="rounded shadow-sm">
      <CardContent className="p-5">
        <div className="text-sm text-slate-500">{label}</div>
        <div className="mt-1 text-2xl font-bold">{value}</div>
      </CardContent>
    </Card>
  );
}

function ActivitiesView({
  visibleActivities,
  query,
  setQuery,
  draft,
  setDraft,
  addEvent,
  deleteActivity,
  attachDoc,
  loading,
  warehouses,
  isOwner,
}) {
  function setWarehouse(warehouseId) {
    const selectedWarehouse = warehouses.find((warehouse) => warehouse.id === warehouseId) || warehouses[0] || DEFAULT_WAREHOUSE;
    setDraft({ ...draft, warehouse_id: selectedWarehouse.id || "", warehouse: selectedWarehouse.name });
  }

  return (
    <>
      <Header title="Activities" subtitle="Inbound, outbound, repack, notes, and documents per event." />
      <Card className="mb-6 rounded shadow-sm">
        <CardContent className="p-5">
          <div className="grid grid-cols-6 gap-3">
            <Input label="Date" type="date" value={draft.activity_date} onChange={(value) => setDraft({ ...draft, activity_date: value })} />
            <Select
              label="Warehouse"
              value={draft.warehouse_id}
              onChange={setWarehouse}
              options={warehouses}
              disabled={!isOwner}
              getOptionLabel={warehouseLabel}
              getOptionValue={(warehouse) => warehouse.id || warehouse.code}
            />
            <Input label="Activity/pallet" type="number" value={draft.pallets} onChange={(value) => setDraft({ ...draft, pallets: value })} />
            <Input label="Piece count" type="number" value={draft.pieces} onChange={(value) => setDraft({ ...draft, pieces: value })} />
            <Input label="Product" value={draft.product} onChange={(value) => setDraft({ ...draft, product: value })} />
            <Input label="Customer" value={draft.customer} onChange={(value) => setDraft({ ...draft, customer: value })} />
            <Input label="Lot number" value={draft.lot_number} onChange={(value) => setDraft({ ...draft, lot_number: value })} />
            <Input label="Supplier" value={draft.supplier} onChange={(value) => setDraft({ ...draft, supplier: value })} />
            <Input label="Repack?" value={draft.repack} onChange={(value) => setDraft({ ...draft, repack: value })} />
            <Input label="Note" value={draft.note} onChange={(value) => setDraft({ ...draft, note: value })} />
            <div className="col-span-2 flex items-end">
              <Button onClick={addEvent} className="w-full">
                <Plus size={16} className="mr-2" />
                Add event
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      <div className="mb-4 flex items-center gap-3">
        <div className="relative flex-1">
          <Search size={18} className="absolute left-3 top-3 text-slate-400" />
          <input
            className="w-full rounded border bg-white py-2 pr-3 pl-10"
            placeholder="Search activities..."
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
      </div>

      {loading ? (
        <div className="rounded border bg-white p-6 text-sm text-slate-500 shadow-sm">Loading activities...</div>
      ) : (
        <Table
          headers={["Date", "Whse", "Pallet", "Pieces", "Product", "Customer", "Supplier", "Docs", ""]}
          rows={visibleActivities.map((activity) => [
            activity.activity_date,
            getActivityWarehouseName(activity),
            activity.pallets,
            activity.pieces,
            activity.product,
            activity.customer || "-",
            activity.supplier || "-",
            <DocUpload key={activity.id} docs={activity.docs} onChange={(files) => attachDoc(activity.id, files)} />,
            <Button key="del" size="sm" variant="ghost" onClick={() => deleteActivity(activity.id)}>
              <Trash2 size={16} />
            </Button>,
          ])}
        />
      )}
    </>
  );
}

function InventoryView({ warehouse, rows, totals }) {
  return (
    <>
      <Header title={`Inventory - ${warehouse}`} subtitle="In = inventory before today; Reserved = future outbound; Incoming = future inbound." />
      <div className="mb-6 grid grid-cols-3 gap-4">
        <KPI label="In" value={totals.in_qty} />
        <KPI label="Reserved" value={totals.reserved_qty} />
        <KPI label="Incoming" value={totals.incoming_qty} />
      </div>
      <Table
        headers={["Item", "Warehouse", "In", "Reserved", "Incoming", "Available"]}
        rows={rows.map((row) => [row.item, row.warehouse, row.in_qty, row.reserved_qty, row.incoming_qty, row.in_qty - row.reserved_qty])}
      />
    </>
  );
}

function ChargesView({ month, charges }) {
  return (
    <>
      <Header title={`Charges - ${month}`} subtitle="Storage, inbound handling, outbound handling, invoices, and charge details." />
      <div className="mb-6 grid grid-cols-4 gap-4">
        <KPI label="Storage" value={money(charges.storageSubtotal)} />
        <KPI label="Inbound" value={money(charges.inboundSubtotal)} />
        <KPI label="Outbound" value={money(charges.outboundSubtotal)} />
        <KPI label="Total" value={money(charges.total)} />
      </div>
      <div className="mb-6 grid grid-cols-3 gap-6">
        <Card className="rounded shadow-sm">
          <CardContent className="p-5">
            <h3 className="mb-2 font-semibold">Billing Rates</h3>
            <Rate label="Storage" value={`${money(charges.storageRate)} / unit / week`} />
            <Rate label="Inbound" value={`${money(charges.inboundRate)} / HU`} />
            <Rate label="Outbound" value={`${money(charges.outboundRate)} / HU`} />
            <Button variant="outline" className="mt-4">
              Edit rates
            </Button>
          </CardContent>
        </Card>
        <Card className="col-span-2 rounded shadow-sm">
          <CardContent className="p-5">
            <h3 className="mb-2 flex items-center gap-2 font-semibold">
              <FileText size={18} />
              Invoices
            </h3>
            {charges.invoices.map((invoice) => (
              <div key={invoice} className="flex justify-between border-b py-3">
                <span>{invoice}</span>
                <span className="font-medium text-green-700">PAID</span>
              </div>
            ))}
            <Button variant="outline" className="mt-4">
              <Upload size={16} className="mr-2" />
              Attach PDF invoice
            </Button>
          </CardContent>
        </Card>
      </div>
      <SectionTable title="Weekly Storage Breakdown" headers={["Period", "Units on hand", "Rate", "Charge"]} rows={charges.weekly.map((row) => [row[0], row[1], money(charges.storageRate), money(row[2])])} />
      <SectionTable title="Inbound Movements" headers={["Date", "SKU", "Description", "HU", "Charge"]} rows={charges.inbound.map((row) => [row[0], row[1], row[2], row[3], money(row[4])])} />
      <SectionTable title="Outbound Movements" headers={["Date", "SKU", "Description", "HU", "Charge"]} rows={charges.outbound.map((row) => [row[0], row[1], row[2], row[3], money(row[4])])} />
    </>
  );
}

function SettingsView({ warehouses, settingsTab, setSettingsTab, saveWarehouse, profile }) {
  return (
    <>
      <Header title="Settings" subtitle="Owner-level users and warehouse master data." />
      <div className="mb-4 inline-flex rounded border bg-white p-1">
        {["Users", "Warehouses"].map((tab) => (
          <button
            key={tab}
            onClick={() => setSettingsTab(tab)}
            className={`rounded px-4 py-2 text-sm font-medium ${settingsTab === tab ? "bg-slate-900 text-white" : "text-slate-600 hover:bg-slate-100"}`}
          >
            {tab}
          </button>
        ))}
      </div>

      {settingsTab === "Users" ? (
        <Card className="rounded shadow-sm">
          <CardContent className="p-5">
            <Table
              headers={["User", "Role", "Warehouse"]}
              rows={[[profile.id || "Current user", profile.role || "owner", profile.warehouse_name || "All warehouses"]]}
            />
          </CardContent>
        </Card>
      ) : (
        <WarehouseSettings warehouses={warehouses} saveWarehouse={saveWarehouse} />
      )}
    </>
  );
}

function WarehouseSettings({ warehouses, saveWarehouse }) {
  const [draftWarehouse, setDraftWarehouse] = useState({ code: "", name: "", active: true });
  const [edits, setEdits] = useState({});

  function updateEdit(id, changes) {
    setEdits((current) => ({ ...current, [id]: { ...current[id], ...changes } }));
  }

  function rowState(warehouse) {
    return { ...warehouse, ...(edits[warehouse.id] || {}) };
  }

  async function addWarehouse() {
    await saveWarehouse(draftWarehouse);
    setDraftWarehouse({ code: "", name: "", active: true });
  }

  return (
    <div className="space-y-6">
      <Card className="rounded shadow-sm">
        <CardContent className="p-5">
          <h3 className="mb-4 font-semibold">Add Warehouse</h3>
          <div className="grid grid-cols-4 gap-3">
            <Input label="Code" value={draftWarehouse.code} onChange={(value) => setDraftWarehouse({ ...draftWarehouse, code: value })} />
            <Input label="Name" value={draftWarehouse.name} onChange={(value) => setDraftWarehouse({ ...draftWarehouse, name: value })} />
            <label className="flex items-end gap-2 pb-2 text-sm text-slate-700">
              <input
                type="checkbox"
                checked={draftWarehouse.active}
                onChange={(event) => setDraftWarehouse({ ...draftWarehouse, active: event.target.checked })}
              />
              Active
            </label>
            <div className="flex items-end">
              <Button onClick={addWarehouse} className="w-full">
                <Plus size={16} className="mr-2" />
                Add warehouse
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      <Table
        headers={["Code", "Name", "Active", ""]}
        rows={warehouses.map((warehouse) => {
          const edited = rowState(warehouse);
          return [
            <input
              key="code"
              className="w-full rounded border px-3 py-2 text-sm"
              value={edited.code}
              onChange={(event) => updateEdit(warehouse.id, { code: event.target.value })}
            />,
            <input
              key="name"
              className="w-full rounded border px-3 py-2 text-sm"
              value={edited.name}
              onChange={(event) => updateEdit(warehouse.id, { name: event.target.value })}
            />,
            <input
              key="active"
              type="checkbox"
              checked={edited.active}
              onChange={(event) => updateEdit(warehouse.id, { active: event.target.checked })}
            />,
            <Button key="save" size="sm" onClick={() => saveWarehouse(edited)}>
              <Save size={14} className="mr-2" />
              Save
            </Button>,
          ];
        })}
      />
    </div>
  );
}

function Header({ title, subtitle }) {
  return (
    <div className="mb-6">
      <h1 className="text-3xl font-bold tracking-tight">{title}</h1>
      <p className="mt-1 text-slate-500">{subtitle}</p>
    </div>
  );
}

function Rate({ label, value }) {
  return (
    <div className="flex justify-between border-b py-2">
      <span className="text-slate-500">{label}</span>
      <span className="font-semibold">{value}</span>
    </div>
  );
}

function Input({ label, value, onChange, type = "text" }) {
  return (
    <label className="text-xs font-medium text-slate-500">
      <span>{label}</span>
      <input type={type} className="mt-1 w-full rounded border bg-white px-3 py-2 text-sm" value={value} onChange={(event) => onChange(event.target.value)} />
    </label>
  );
}

function Select({ label, value, onChange, options, disabled = false, getOptionLabel = (option) => option, getOptionValue = (option) => option }) {
  return (
    <label className="text-xs font-medium text-slate-500">
      <span>{label}</span>
      <select
        className="mt-1 w-full rounded border bg-white px-3 py-2 text-sm disabled:bg-slate-100"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        disabled={disabled}
      >
        {options.map((option) => (
          <option key={getOptionValue(option)} value={getOptionValue(option)}>
            {getOptionLabel(option)}
          </option>
        ))}
      </select>
    </label>
  );
}

function DocUpload({ docs = [], onChange }) {
  return (
    <div>
      <label className="inline-flex cursor-pointer items-center gap-1 text-xs text-slate-700">
        <Upload size={14} />
        Upload
        <input type="file" multiple className="hidden" onChange={(event) => onChange(event.target.files)} />
      </label>

      <div className="mt-1 text-xs text-slate-500">{docs.length ? docs.join(", ") : "-"}</div>
    </div>
  );
}

function SectionTable({ title, headers, rows }) {
  return (
    <div className="mb-6">
      <h3 className="mb-2 font-semibold">{title}</h3>
      <Table headers={headers} rows={rows} />
    </div>
  );
}

function Table({ headers, rows }) {
  return (
    <div className="overflow-hidden rounded border bg-white shadow-sm">
      <table className="w-full text-sm">
        <thead className="bg-slate-100 text-slate-600">
          <tr>
            {headers.map((header) => (
              <th key={header} className="px-4 py-3 text-left font-semibold">
                {header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={index} className="border-t hover:bg-slate-50">
              {row.map((cell, cellIndex) => (
                <td key={cellIndex} className="px-4 py-3 align-top">
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Card({ children, className = "" }) {
  return <div className={className}>{children}</div>;
}

function CardContent({ children, className = "" }) {
  return <div className={className}>{children}</div>;
}

function Button({ children, className = "", variant = "default", size = "default", ...props }) {
  const base = "inline-flex items-center justify-center rounded px-4 py-2 text-sm font-medium transition";
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
    <button className={`${base} ${variants[variant]} ${sizes[size]} ${className}`} {...props}>
      {children}
    </button>
  );
}
