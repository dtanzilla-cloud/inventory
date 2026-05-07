import { useMemo, useState, useEffect } from "react";
import { motion } from "framer-motion";
import {
  Search,
  Plus,
  Trash2,
  Upload,
  FileText,
  LogIn,
  LogOut,
  Settings,
  Warehouse,
  Activity,
  DollarSign,
} from "lucide-react";
import { supabase } from "./supabaseClient";

const warehouses = ["All", "Warehouse A"];
const DOCUMENT_BUCKET = "activity-documents";
const CHARGE_INVOICE_BUCKET = "charge-invoices";
const DEFAULT_CHARGE_MONTH = "December 2025";

const emptyDraft = {
  activity_date: new Date().toISOString().slice(0, 10),
  warehouse: "Warehouse A",
  pallets: 0,
  pieces: 0,
  product: "",
  customer: "",
  lot_number: "",
  supplier: "",
  repack: "",
  note: "",
};

function money(n) {
  return n.toLocaleString(undefined, { style: "currency", currency: "USD" });
}

function toMonthKey(dateValue) {
  return (dateValue || "").slice(0, 7);
}

function monthLabelFromKey(monthKey) {
  const [year, month] = monthKey.split("-").map(Number);
  if (!year || !month) return DEFAULT_CHARGE_MONTH;
  return new Date(year, month - 1, 1).toLocaleDateString(undefined, { month: "long", year: "numeric" });
}

function monthKeyFromLabel(label) {
  const date = new Date(`${label} 1`);
  if (Number.isNaN(date.getTime())) return "2025-12";
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

function shortDate(dateValue) {
  const date = new Date(`${dateValue}T00:00:00`);
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function slugify(value) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
}

function activityUnits(activity) {
  return Math.abs(Number(activity.pallets) || 0);
}

function signedActivityUnits(activity) {
  const pallets = Number(activity.pallets) || 0;
  if (pallets === 0) return 0;
  return Number(activity.pieces) < 0 ? -Math.abs(pallets) : Math.abs(pallets);
}

function buildWeeklyStorageRows(monthKey, activities, storageRate) {
  const [year, month] = monthKey.split("-").map(Number);
  const lastDay = new Date(year, month, 0).getDate();
  const rows = [];

  for (let start = 1; start <= lastDay; start += 7) {
    const end = Math.min(start + 6, lastDay);
    const startDate = `${monthKey}-${String(start).padStart(2, "0")}`;
    const endDate = `${monthKey}-${String(end).padStart(2, "0")}`;
    const units = activities
      .filter((activity) => activity.activity_date < startDate)
      .reduce((sum, activity) => sum + signedActivityUnits(activity), 0);
    const unitsOnHand = Math.max(0, units);

    rows.push([
      rows.length + 1,
      `${shortDate(`${monthKey}-${String(start).padStart(2, "0")}`)} - ${shortDate(endDate)}`,
      unitsOnHand,
      storageRate,
      unitsOnHand * storageRate,
    ]);
  }

  return rows;
}

function calculateCharges(monthKey, activities, rates, invoices) {
  const storageRate = Number(rates?.storage_rate ?? 6);
  const inboundRate = Number(rates?.inbound_rate ?? 10);
  const outboundRate = Number(rates?.outbound_rate ?? 10);
  const monthlyActivities = activities.filter((activity) => toMonthKey(activity.activity_date) === monthKey);

  const inbound = monthlyActivities
    .filter((activity) => Number(activity.pieces) > 0)
    .map((activity) => {
      const units = activityUnits(activity);
      return [shortDate(activity.activity_date), slugify(activity.product), activity.product, units, units * inboundRate];
    });

  const outbound = monthlyActivities
    .filter((activity) => Number(activity.pieces) < 0)
    .map((activity) => {
      const units = activityUnits(activity);
      return [shortDate(activity.activity_date), slugify(activity.product), activity.product, units, units * outboundRate];
    });

  const weekly = buildWeeklyStorageRows(monthKey, activities, storageRate);
  const storageSubtotal = weekly.reduce((sum, row) => sum + row[4], 0);
  const inboundSubtotal = inbound.reduce((sum, row) => sum + row[4], 0);
  const outboundSubtotal = outbound.reduce((sum, row) => sum + row[4], 0);

  return {
    storageRate,
    inboundRate,
    outboundRate,
    storageSubtotal,
    inboundSubtotal,
    outboundSubtotal,
    total: storageSubtotal + inboundSubtotal + outboundSubtotal,
    invoices,
    weekly,
    inbound,
    outbound,
  };
}

function normalizeActivity(activity) {
  return {
    ...activity,
    activity_date: activity.activity_date || activity.date || "",
    documents: Array.isArray(activity.documents) ? activity.documents : [],
  };
}

function sanitizeFileName(fileName) {
  return fileName.replace(/[^a-zA-Z0-9._-]/g, "_");
}

export default function InventoryManagementSystem() {
  const [session, setSession] = useState(null);
  const [profile, setProfile] = useState(null);
  const [profiles, setProfiles] = useState([]);
  const [section, setSection] = useState("Activities");
  const [warehouse, setWarehouse] = useState("All");
  const [activities, setActivities] = useState([]);
  const [inventoryLedger, setInventoryLedger] = useState([]);
  const [query, setQuery] = useState("");
  const [month, setMonth] = useState("");
  const [billingRates, setBillingRates] = useState({});
  const [chargeInvoices, setChargeInvoices] = useState({});
  const [chargeMonths, setChargeMonths] = useState([DEFAULT_CHARGE_MONTH]);
  const [draft, setDraft] = useState(emptyDraft);
  const [authLoading, setAuthLoading] = useState(true);
  const [loading, setLoading] = useState(false);
  const [chargesLoading, setChargesLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");
  const [uploadingActivityId, setUploadingActivityId] = useState(null);
  const [uploadingInvoice, setUploadingInvoice] = useState(false);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setAuthLoading(false);
    });

    const { data: listener } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      setSession(nextSession);
      if (!nextSession) {
        setProfile(null);
        setActivities([]);
        setInventoryLedger([]);
        setProfiles([]);
        setBillingRates({});
        setChargeInvoices({});
      }
    });

    return () => listener.subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (!session?.user) return;
    loadProfile(session.user);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session]);

  useEffect(() => {
    if (!profile) return;
    loadActivities(profile);
    if (profile.role === "owner") {
      loadProfiles();
      loadCharges();
    }
    loadInventoryLedger(profile);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile]);

  async function loadProfile(user) {
    setErrorMessage("");

    const { data, error } = await supabase
      .from("profiles")
      .select("id, email, role, warehouse")
      .eq("id", user.id)
      .single();

    if (error) {
      console.error(error);
      setErrorMessage("No profile is configured for this user.");
      setProfile(null);
      return;
    }

    if (data.role === "warehouse") {
      setWarehouse(data.warehouse);
      setDraft((current) => ({ ...current, warehouse: data.warehouse }));
      if (section === "Charges" || section === "Settings") setSection("Activities");
    }

    setProfile(data);
  }

  async function loadProfiles() {
    const { data, error } = await supabase
      .from("profiles")
      .select("id, email, role, warehouse")
      .order("email", { ascending: true });

    if (error) {
      console.error(error);
      setErrorMessage("Settings loaded, but user profiles could not be loaded.");
    } else {
      setProfiles(data || []);
    }
  }

  async function loadActivities(activeProfile = profile) {
    if (!activeProfile) return;

    setLoading(true);
    setErrorMessage("");

    let activityQuery = supabase
      .from("activities")
      .select("*")
      .order("activity_date", { ascending: false });

    if (activeProfile.role === "warehouse") {
      activityQuery = activityQuery.eq("warehouse", activeProfile.warehouse);
    }

    const { data, error } = await activityQuery;

    if (error) {
      console.error(error);
      setErrorMessage("Could not load activities from Supabase.");
      setActivities([]);
    } else {
      const loadedActivities = (data || []).map(normalizeActivity);
      const activityIds = loadedActivities.map((activity) => activity.id).filter(Boolean);

      if (activityIds.length === 0) {
        setActivities(loadedActivities);
      } else {
        const { data: documents, error: documentsError } = await supabase
          .from("documents")
          .select("id, activity_id, file_name, file_url")
          .in("activity_id", activityIds)
          .order("file_name", { ascending: true });

        if (documentsError) {
          console.error(documentsError);
          setErrorMessage("Activities loaded, but documents could not be loaded.");
          setActivities(loadedActivities);
        } else {
          const documentsByActivity = (documents || []).reduce((acc, document) => {
            const key = String(document.activity_id);
            acc[key] = [...(acc[key] || []), document];
            return acc;
          }, {});

          setActivities(
            loadedActivities.map((activity) => ({
              ...activity,
              documents: documentsByActivity[String(activity.id)] || [],
            })),
          );
        }
      }
    }

    setLoading(false);
  }

  async function loadInventoryLedger(activeProfile = profile) {
    if (!activeProfile) return;

    let ledgerQuery = supabase
      .from("inventory_ledger")
      .select("*")
      .order("warehouse", { ascending: true })
      .order("item", { ascending: true });

    if (activeProfile.role === "warehouse") {
      ledgerQuery = ledgerQuery.eq("warehouse", activeProfile.warehouse);
    }

    const { data, error } = await ledgerQuery;

    if (error) {
      console.error(error);
      setErrorMessage("Inventory could not be loaded from Supabase.");
      setInventoryLedger([]);
      return;
    }

    setInventoryLedger(data || []);
  }

  async function loadCharges() {
    setChargesLoading(true);

    const [ratesResult, invoicesResult, summariesResult] = await Promise.all([
      supabase.from("billing_rates").select("month, storage_rate, inbound_rate, outbound_rate").order("month", { ascending: false }),
      supabase.from("charge_invoices").select("id, month, file_name, file_url, status").order("created_at", { ascending: false }),
      supabase.from("monthly_charge_summaries").select("*").order("month", { ascending: false }),
    ]);

    if (ratesResult.error || invoicesResult.error || summariesResult.error) {
      console.error(ratesResult.error || invoicesResult.error || summariesResult.error);
      setErrorMessage("Charges could not be loaded from Supabase.");
      setChargesLoading(false);
      return;
    }

    const nextRates = (ratesResult.data || []).reduce((acc, rate) => {
      acc[rate.month] = rate;
      return acc;
    }, {});
    const nextInvoices = (invoicesResult.data || []).reduce((acc, invoice) => {
      acc[invoice.month] = [...(acc[invoice.month] || []), invoice];
      return acc;
    }, {});
    const months = new Set([
      ...Object.keys(nextRates),
      ...Object.keys(nextInvoices),
      ...(summariesResult.data || []).map((summary) => summary.month),
      ...activities.map((activity) => toMonthKey(activity.activity_date)).filter(Boolean),
      monthKeyFromLabel(DEFAULT_CHARGE_MONTH),
    ]);
    const labels = Array.from(months).sort().reverse().map(monthLabelFromKey);

    setBillingRates(nextRates);
    setChargeInvoices(nextInvoices);
    setChargeMonths(labels);
    setChargesLoading(false);
  }

  const visibleActivities = activities.filter(
    (a) =>
      (warehouse === "All" || a.warehouse === warehouse) &&
      JSON.stringify(a).toLowerCase().includes(query.toLowerCase()),
  );

  const visibleInventory = useMemo(
    () => inventoryLedger.filter((i) => warehouse === "All" || i.warehouse === warehouse),
    [inventoryLedger, warehouse],
  );
  const visibleChargeMonths = useMemo(
    () => Array.from(new Set([
      ...chargeMonths,
      ...activities.map((activity) => monthLabelFromKey(toMonthKey(activity.activity_date))).filter(Boolean),
    ])).sort((a, b) => monthKeyFromLabel(b).localeCompare(monthKeyFromLabel(a))),
    [activities, chargeMonths],
  );
  const selectedChargeMonth = month || visibleChargeMonths[0] || DEFAULT_CHARGE_MONTH;
  const totals = visibleInventory.reduce(
    (acc, r) => ({
      in_qty: acc.in_qty + Number(r.in_qty || 0),
      reserved_qty: acc.reserved_qty + Number(r.reserved_qty || 0),
      incoming_qty: acc.incoming_qty + Number(r.incoming_qty || 0),
      available_qty: acc.available_qty + Number(r.available_qty || 0),
    }),
    { in_qty: 0, reserved_qty: 0, incoming_qty: 0, available_qty: 0 },
  );
  const chargeMonthKey = monthKeyFromLabel(selectedChargeMonth);
  const charges = calculateCharges(
    chargeMonthKey,
    activities,
    billingRates[chargeMonthKey],
    chargeInvoices[chargeMonthKey] || [],
  );

  async function addEvent() {
    if (!draft.product || !profile) return;

    const payload = {
      activity_date: draft.activity_date,
      warehouse: profile.role === "warehouse" ? profile.warehouse : draft.warehouse,
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
    await loadInventoryLedger();
    setDraft({ ...emptyDraft, warehouse: profile.role === "warehouse" ? profile.warehouse : "Warehouse A" });
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
    await loadInventoryLedger();
  }

  async function uploadDocuments(activityId, fileList) {
    const files = Array.from(fileList || []);
    if (!activityId || files.length === 0) return;

    setErrorMessage("");
    setUploadingActivityId(activityId);

    try {
      const uploadedDocuments = [];

      for (const file of files) {
        const storagePath = `${activityId}/${crypto.randomUUID()}-${sanitizeFileName(file.name)}`;

        const { error: uploadError } = await supabase.storage
          .from(DOCUMENT_BUCKET)
          .upload(storagePath, file, { upsert: false });

        if (uploadError) throw uploadError;

        const { data: publicUrlData } = supabase.storage
          .from(DOCUMENT_BUCKET)
          .getPublicUrl(storagePath);

        const documentPayload = {
          activity_id: activityId,
          file_name: file.name,
          file_url: publicUrlData.publicUrl,
        };

        const { data: insertedDocument, error: insertError } = await supabase
          .from("documents")
          .insert([documentPayload])
          .select("id, activity_id, file_name, file_url")
          .single();

        if (insertError) throw insertError;
        uploadedDocuments.push(insertedDocument);
      }

      setActivities((current) =>
        current.map((activity) =>
          activity.id === activityId
            ? { ...activity, documents: [...activity.documents, ...uploadedDocuments] }
            : activity,
        ),
      );
    } catch (error) {
      console.error(error);
      setErrorMessage("Document upload failed. Please try again.");
    } finally {
      setUploadingActivityId(null);
    }
  }

  async function saveBillingRates(monthLabel, nextRates) {
    const targetMonth = monthKeyFromLabel(monthLabel);
    const payload = {
      month: targetMonth,
      storage_rate: Number(nextRates.storageRate),
      inbound_rate: Number(nextRates.inboundRate),
      outbound_rate: Number(nextRates.outboundRate),
    };

    const { data, error } = await supabase
      .from("billing_rates")
      .upsert(payload, { onConflict: "month" })
      .select("month, storage_rate, inbound_rate, outbound_rate")
      .single();

    if (error) {
      console.error(error);
      setErrorMessage("Billing rates could not be saved.");
      return;
    }

    setBillingRates((current) => ({ ...current, [targetMonth]: data }));
  }

  async function uploadChargeInvoices(monthLabel, fileList) {
    const files = Array.from(fileList || []);
    if (files.length === 0) return;

    const targetMonth = monthKeyFromLabel(monthLabel);
    setUploadingInvoice(true);
    setErrorMessage("");

    try {
      const uploadedInvoices = [];

      for (const file of files) {
        const storagePath = `${targetMonth}/${crypto.randomUUID()}-${sanitizeFileName(file.name)}`;
        const { error: uploadError } = await supabase.storage
          .from(CHARGE_INVOICE_BUCKET)
          .upload(storagePath, file, { upsert: false, contentType: file.type || "application/pdf" });

        if (uploadError) throw uploadError;

        const { data: publicUrlData } = supabase.storage
          .from(CHARGE_INVOICE_BUCKET)
          .getPublicUrl(storagePath);

        const { data: invoice, error: invoiceError } = await supabase
          .from("charge_invoices")
          .insert([{ month: targetMonth, file_name: file.name, file_url: publicUrlData.publicUrl, status: "PAID" }])
          .select("id, month, file_name, file_url, status")
          .single();

        if (invoiceError) throw invoiceError;
        uploadedInvoices.push(invoice);
      }

      setChargeInvoices((current) => ({
        ...current,
        [targetMonth]: [...(current[targetMonth] || []), ...uploadedInvoices],
      }));
    } catch (error) {
      console.error(error);
      setErrorMessage("Invoice upload failed. Please try again.");
    } finally {
      setUploadingInvoice(false);
    }
  }

  if (authLoading) {
    return <div className="flex min-h-screen items-center justify-center bg-slate-50 text-sm text-slate-500">Loading...</div>;
  }

  if (!session || !profile) {
    return <LoginView errorMessage={errorMessage} isSignedIn={Boolean(session)} />;
  }

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      <div className="flex">
        <aside className="w-72 min-h-screen bg-white border-r border-slate-200 p-5 sticky top-0">
          <div className="mb-8">
            <div className="text-xl font-bold">Adeline Inventory</div>
            <div className="text-sm text-slate-500">Online warehouse portal</div>
            <div className="mt-3 text-xs text-slate-500">{profile.email}</div>
          </div>

          <NavButton icon={<Activity size={18} />} active={section === "Activities"} onClick={() => setSection("Activities")}>Activities</NavButton>

          <div className="mt-4 mb-2 text-xs font-semibold text-slate-400 uppercase">Inventory</div>
          {(profile.role === "owner" ? warehouses : [profile.warehouse]).map((w) => <NavButton key={w} icon={<Warehouse size={18} />} active={section === "Inventory" && warehouse === w} onClick={() => { setSection("Inventory"); setWarehouse(w); }}>{w}</NavButton>)}

          {profile.role === "owner" && <>
            <div className="mt-4 mb-2 text-xs font-semibold text-slate-400 uppercase">Charges</div>
            <NavButton icon={<DollarSign size={18} />} active={section === "Charges"} onClick={() => setSection("Charges")}>Charges</NavButton>

            <div className="mt-4 mb-2 text-xs font-semibold text-slate-400 uppercase">Settings</div>
            <NavButton icon={<Settings size={18} />} active={section === "Settings"} onClick={() => setSection("Settings")}>Users</NavButton>
          </>}

          <div className="mt-8 pt-4 border-t border-slate-200">
            <Button variant="outline" className="w-full" onClick={() => supabase.auth.signOut()}><LogOut size={16} className="mr-2" />Log out</Button>
          </div>
        </aside>

        <main className="flex-1 p-8">
          <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}>
            {errorMessage && <div className="mb-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{errorMessage}</div>}
            {section === "Activities" && <ActivitiesView {...{ visibleActivities, query, setQuery, draft, setDraft, addEvent, deleteActivity, uploadDocuments, uploadingActivityId, loading, profile }} />}
            {section === "Inventory" && <InventoryView warehouse={warehouse} rows={visibleInventory} totals={totals} />}
            {section === "Charges" && profile.role === "owner" && <ChargesView month={selectedChargeMonth} months={visibleChargeMonths} setMonth={setMonth} charges={charges} loading={chargesLoading} uploadingInvoice={uploadingInvoice} onSaveRates={saveBillingRates} onUploadInvoices={uploadChargeInvoices} />}
            {section === "Settings" && profile.role === "owner" && <SettingsView profiles={profiles} />}
          </motion.div>
        </main>
      </div>
    </div>
  );
}

function LoginView({ errorMessage, isSignedIn }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [authError, setAuthError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  async function signIn(event) {
    event.preventDefault();
    setSubmitting(true);
    setAuthError("");

    const { error } = await supabase.auth.signInWithPassword({ email, password });

    if (error) setAuthError(error.message);
    setSubmitting(false);
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-50 p-6">
      <Card className="w-full max-w-md rounded-2xl border bg-white shadow-sm">
        <CardContent className="p-6">
          <div className="mb-6">
            <h1 className="text-2xl font-bold tracking-tight">Adeline Inventory</h1>
            <p className="text-sm text-slate-500 mt-1">Sign in with your Supabase account.</p>
          </div>
          {(authError || errorMessage) && <div className="mb-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{authError || errorMessage}</div>}
          <form onSubmit={signIn} className="space-y-4">
            <Input label="Email" type="email" value={email} onChange={setEmail} />
            <Input label="Password" type="password" value={password} onChange={setPassword} />
            <Button className="w-full" disabled={submitting}><LogIn size={16} className="mr-2" />{submitting ? "Signing in" : "Log in"}</Button>
          </form>
          {isSignedIn && <Button type="button" variant="outline" className="mt-3 w-full" onClick={() => supabase.auth.signOut()}><LogOut size={16} className="mr-2" />Log out</Button>}
        </CardContent>
      </Card>
    </div>
  );
}

function NavButton({ icon, active, children, onClick }) {
  return <button onClick={onClick} className={`w-full flex items-center gap-3 px-3 py-2 rounded-xl text-sm mb-1 transition ${active ? "bg-slate-900 text-white" : "hover:bg-slate-100 text-slate-700"}`}>{icon}<span>{children}</span></button>;
}

function KPI({ label, value }) {
  return <Card className="rounded-2xl shadow-sm"><CardContent className="p-5"><div className="text-sm text-slate-500">{label}</div><div className="text-2xl font-bold mt-1">{value}</div></CardContent></Card>;
}

function ActivitiesView({ visibleActivities, query, setQuery, draft, setDraft, addEvent, deleteActivity, uploadDocuments, uploadingActivityId, loading, profile }) {
  return <>
    <Header title="Activities" subtitle="Inbound, outbound, repack, notes, and documents per event." />
    <Card className="rounded-2xl shadow-sm mb-6"><CardContent className="p-5">
      <div className="grid grid-cols-6 gap-3">
        <Input label="Date" type="date" value={draft.activity_date} onChange={(v) => setDraft({ ...draft, activity_date: v })} />
        <Select label="Warehouse" value={profile.role === "warehouse" ? profile.warehouse : draft.warehouse} onChange={(v) => setDraft({ ...draft, warehouse: v })} options={profile.role === "owner" ? warehouses.slice(1) : [profile.warehouse]} disabled={profile.role === "warehouse"} />
        <Input label="Activity/pallet" type="number" value={draft.pallets} onChange={(v) => setDraft({ ...draft, pallets: v })} />
        <Input label="Piece count" type="number" value={draft.pieces} onChange={(v) => setDraft({ ...draft, pieces: v })} />
        <Input label="Product" value={draft.product} onChange={(v) => setDraft({ ...draft, product: v })} />
        <Input label="Customer" value={draft.customer} onChange={(v) => setDraft({ ...draft, customer: v })} />
        <Input label="Lot number" value={draft.lot_number} onChange={(v) => setDraft({ ...draft, lot_number: v })} />
        <Input label="Supplier" value={draft.supplier} onChange={(v) => setDraft({ ...draft, supplier: v })} />
        <Input label="Repack?" value={draft.repack} onChange={(v) => setDraft({ ...draft, repack: v })} />
        <Input label="Note" value={draft.note} onChange={(v) => setDraft({ ...draft, note: v })} />
        <div className="col-span-2 flex items-end"><Button onClick={addEvent} className="w-full rounded-xl"><Plus size={16} className="mr-2" />Add event</Button></div>
      </div>
    </CardContent></Card>

    <div className="flex items-center gap-3 mb-4">
      <div className="relative flex-1"><Search size={18} className="absolute left-3 top-3 text-slate-400" /><input className="w-full pl-10 pr-3 py-2 rounded-xl border bg-white" placeholder="Search activities..." value={query} onChange={(e) => setQuery(e.target.value)} /></div>
    </div>

    {loading ? (
      <div className="rounded-2xl border bg-white p-6 text-sm text-slate-500 shadow-sm">Loading activities...</div>
    ) : (
      <Table headers={["Date", "Pallet", "Pieces", "Product", "Customer", "Supplier", "Docs", ""]} rows={visibleActivities.map((a) => [a.activity_date, a.pallets, a.pieces, a.product, a.customer || "-", a.supplier || "-", <DocUpload key={a.id} documents={a.documents} uploading={uploadingActivityId === a.id} onChange={(files) => uploadDocuments(a.id, files)} />, <Button key="del" size="sm" variant="ghost" onClick={() => deleteActivity(a.id)}><Trash2 size={16} /></Button>])} />
    )}
  </>;
}

function InventoryView({ warehouse, rows, totals }) {
  return <>
    <Header title={`Inventory - ${warehouse}`} subtitle="In = inventory before today; Reserved = future outbound; Incoming = future inbound." />
    <div className="grid grid-cols-3 gap-4 mb-6"><KPI label="In" value={totals.in_qty} /><KPI label="Reserved" value={totals.reserved_qty} /><KPI label="Incoming" value={totals.incoming_qty} /></div>
    <Table headers={["Item", "In", "Reserved", "Incoming", "Available"]} rows={rows.map((r) => [r.item, r.in_qty, r.reserved_qty, r.incoming_qty, r.available_qty])} />
  </>;
}

function ChargesView({ month, months, setMonth, charges, loading, uploadingInvoice, onSaveRates, onUploadInvoices }) {
  const [editingRates, setEditingRates] = useState(false);
  const [rateDraft, setRateDraft] = useState({
    storageRate: charges.storageRate,
    inboundRate: charges.inboundRate,
    outboundRate: charges.outboundRate,
  });

  async function saveRates() {
    await onSaveRates(month, rateDraft);
    setEditingRates(false);
  }

  return <>
    <Header title={`Charges - ${month}`} subtitle="Storage, inbound handling, outbound handling, invoices, and charge details." />
    <div className="mb-4 max-w-xs">
      <Select label="Month" value={month} onChange={setMonth} options={months} />
    </div>
    {loading && <div className="mb-4 rounded-xl border bg-white px-4 py-3 text-sm text-slate-500">Loading charges...</div>}
    <div className="grid grid-cols-4 gap-4 mb-6"><KPI label="Storage" value={money(charges.storageSubtotal)} /><KPI label="Inbound" value={money(charges.inboundSubtotal)} /><KPI label="Outbound" value={money(charges.outboundSubtotal)} /><KPI label="Total" value={money(charges.total)} /></div>
    <div className="grid grid-cols-3 gap-6 mb-6">
      <Card className="rounded-2xl shadow-sm"><CardContent className="p-5">
        <h3 className="font-semibold mb-2">Billing Rates</h3>
        {editingRates ? <>
          <Input label="Storage" type="number" value={rateDraft.storageRate} onChange={(value) => setRateDraft({ ...rateDraft, storageRate: value })} />
          <Input label="Inbound" type="number" value={rateDraft.inboundRate} onChange={(value) => setRateDraft({ ...rateDraft, inboundRate: value })} />
          <Input label="Outbound" type="number" value={rateDraft.outboundRate} onChange={(value) => setRateDraft({ ...rateDraft, outboundRate: value })} />
          <div className="mt-4 flex gap-2">
            <Button onClick={saveRates}>Save</Button>
            <Button variant="outline" onClick={() => setEditingRates(false)}>Cancel</Button>
          </div>
        </> : <>
          <Rate label="Storage" value={`${money(charges.storageRate)} / unit / week`} />
          <Rate label="Inbound" value={`${money(charges.inboundRate)} / HU`} />
          <Rate label="Outbound" value={`${money(charges.outboundRate)} / HU`} />
          <Button variant="outline" className="mt-4 rounded-xl" onClick={() => {
            setRateDraft({
              storageRate: charges.storageRate,
              inboundRate: charges.inboundRate,
              outboundRate: charges.outboundRate,
            });
            setEditingRates(true);
          }}>Edit rates</Button>
        </>}
      </CardContent></Card>
      <Card className="rounded-2xl shadow-sm col-span-2"><CardContent className="p-5">
        <h3 className="font-semibold mb-2 flex items-center gap-2"><FileText size={18} />Invoices</h3>
        {charges.invoices.length ? charges.invoices.map((invoice) => (
          <div key={invoice.id || invoice.file_url} className="flex justify-between border-b py-3">
            <a href={invoice.file_url} target="_blank" rel="noreferrer" className="underline-offset-2 hover:underline">{invoice.file_name}</a>
            <span className="text-green-700 font-medium">{invoice.status || "PAID"}</span>
          </div>
        )) : <div className="border-b py-3 text-sm text-slate-500">No invoices uploaded.</div>}
        <label className={`mt-4 inline-flex items-center justify-center px-4 py-2 rounded-xl text-sm font-medium transition border border-slate-300 bg-white hover:bg-slate-100 ${uploadingInvoice ? "cursor-wait opacity-60" : "cursor-pointer"}`}>
          <Upload size={16} className="mr-2" />{uploadingInvoice ? "Uploading invoice" : "Attach PDF invoice"}
          <input type="file" accept="application/pdf" multiple className="hidden" disabled={uploadingInvoice} onChange={(event) => onUploadInvoices(month, event.target.files)} />
        </label>
      </CardContent></Card>
    </div>
    <SectionTable title="Weekly Storage Breakdown" headers={["Week", "Period", "HU on hand", "Rate", "Charge"]} rows={charges.weekly.map((w) => [w[0], w[1], w[2], money(w[3]), money(w[4])])} />
    <SectionTable title="Inbound Movements" headers={["Date", "SKU", "Description", "Pallet", "Charge"]} rows={charges.inbound.map((r) => [r[0], r[1], r[2], r[3], money(r[4])])} />
    <SectionTable title="Outbound Movements" headers={["Date", "SKU", "Description", "Pallet", "Charge"]} rows={charges.outbound.map((r) => [r[0], r[1], r[2], r[3], money(r[4])])} />
  </>;
}

function SettingsView({ profiles }) {
  return <>
    <Header title="Settings - Users" subtitle="Owner and warehouse-level user access." />
    <Card className="rounded-2xl shadow-sm"><CardContent className="p-5"><Table headers={["User", "Role", "Access"]} rows={profiles.map((user) => [user.email, user.role, user.role === "owner" ? "All warehouses + charges + settings" : `${user.warehouse} activities and inventory only`])} /></CardContent></Card>
  </>;
}

function Header({ title, subtitle }) { return <div className="mb-6"><h1 className="text-3xl font-bold tracking-tight">{title}</h1><p className="text-slate-500 mt-1">{subtitle}</p></div>; }
function Rate({ label, value }) { return <div className="flex justify-between py-2 border-b"><span className="text-slate-500">{label}</span><span className="font-semibold">{value}</span></div>; }
function Input({ label, value, onChange, type = "text" }) { return <label className="text-xs font-medium text-slate-500"><span>{label}</span><input type={type} className="mt-1 w-full px-3 py-2 border rounded-xl bg-white text-sm" value={value} onChange={(e) => onChange(e.target.value)} /></label>; }
function Select({ label, value, onChange, options, disabled = false }) { return <label className="text-xs font-medium text-slate-500"><span>{label}</span><select className="mt-1 w-full px-3 py-2 border rounded-xl bg-white text-sm disabled:bg-slate-100" value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)}>{options.map((o) => <option key={o}>{o}</option>)}</select></label>; }

function DocUpload({ documents = [], uploading, onChange }) {
  return (
    <div>
      <label className={`inline-flex items-center gap-1 text-xs text-slate-700 ${uploading ? "cursor-wait opacity-60" : "cursor-pointer"}`}>
        <Upload size={14} />
        {uploading ? "Uploading" : "Upload"}
        <input type="file" multiple className="hidden" disabled={uploading} onChange={(e) => onChange(e.target.files)} />
      </label>

      <div className="mt-1 space-y-1 text-xs text-slate-500">
        {documents.length
          ? documents.map((document) => (
            <a key={document.id || document.file_url} href={document.file_url} className="block text-slate-700 underline-offset-2 hover:underline" target="_blank" rel="noreferrer">
              {document.file_name}
            </a>
          ))
          : "-"}
      </div>
    </div>
  );
}

function SectionTable({ title, headers, rows }) { return <div className="mb-6"><h3 className="font-semibold mb-2">{title}</h3><Table headers={headers} rows={rows} /></div>; }
function Table({ headers, rows }) { return <div className="overflow-hidden rounded-2xl border bg-white shadow-sm"><table className="w-full text-sm"><thead className="bg-slate-100 text-slate-600"><tr>{headers.map((h) => <th key={h} className="text-left px-4 py-3 font-semibold">{h}</th>)}</tr></thead><tbody>{rows.map((r, idx) => <tr key={idx} className="border-t hover:bg-slate-50">{r.map((c, i) => <td key={i} className="px-4 py-3 align-top">{c}</td>)}</tr>)}</tbody></table></div>; }

function Card({ children, className = "" }) {
  return <div className={className}>{children}</div>;
}

function CardContent({ children, className = "" }) {
  return <div className={className}>{children}</div>;
}

function Button({ children, className = "", variant = "default", size = "default", ...props }) {
  const base = "inline-flex items-center justify-center px-4 py-2 rounded-xl text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-60";
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
