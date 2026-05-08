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
  Save,
} from "lucide-react";
import { supabase } from "./supabaseClient";

const ALL_WAREHOUSES = "All";
const DEFAULT_WAREHOUSE = { id: null, code: "WH-A", name: "Warehouse A", active: true };
const DOCUMENT_BUCKET = "activity-documents";
const CHARGE_INVOICE_BUCKET = "charge-invoices";
const DEFAULT_CHARGE_MONTH = "December 2025";

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

function warehouseName(warehouse) {
  return warehouse?.name || warehouse?.warehouse || "";
}

function warehouseLabel(warehouse) {
  if (!warehouse) return "";
  return warehouse.code ? `${warehouse.name} (${warehouse.code})` : warehouse.name;
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
    role: profile?.role || "warehouse",
    warehouse_id: profile?.warehouse_id || "",
    warehouse_name: profile?.warehouses?.name || profile?.warehouse || "",
    warehouse_code: profile?.warehouses?.code || "",
  };
}

function getActivityWarehouseName(activity) {
  return activity.warehouse_name || activity.warehouses?.name || activity.warehouse || "Unassigned";
}

function getActivityWarehouseKey(activity) {
  return activity.warehouse_id || getActivityWarehouseName(activity);
}

function inventoryKey(item, warehouseKey) {
  return `${item || ""}::${warehouseKey || ""}`;
}

function derivePalletBalances(activities) {
  const today = new Date().toISOString().slice(0, 10);

  return activities.reduce((balances, activity) => {
    const activityWarehouseKey = getActivityWarehouseKey(activity);
    if (!activity.product || !activityWarehouseKey || !activity.activity_date || activity.activity_date >= today) {
      return balances;
    }

    const key = inventoryKey(activity.product, activityWarehouseKey);
    balances.set(key, (balances.get(key) || 0) + signedActivityUnits(activity));
    return balances;
  }, new Map());
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

function rowMatchesWarehouse(row, warehouseFilter) {
  return warehouseFilter === ALL_WAREHOUSES || row.warehouse_id === warehouseFilter || row.warehouse === warehouseFilter;
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
    warehouse_id: activity.warehouse_id || "",
    warehouse_name: activity.warehouses?.name || activity.warehouse || "",
    warehouse_code: activity.warehouses?.code || "",
  };
}

function sanitizeFileName(fileName) {
  return fileName.replace(/[^a-zA-Z0-9._-]/g, "_");
}

const masterDataConfig = {
  Products: { table: "products", activityField: "product", hasSku: true },
  Customers: { table: "customers", activityField: "customer", hasSku: false },
  Suppliers: { table: "suppliers", activityField: "supplier", hasSku: false },
};

function parseCsvNames(text, hasSku = false) {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const [firstLine] = lines;
  const hasHeader = firstLine?.toLowerCase().includes("name");
  const dataLines = hasHeader ? lines.slice(1) : lines;

  return dataLines.map((line) => {
    const [name, sku] = line.split(",").map((value) => value?.trim() || "");
    return hasSku ? { name, sku, active: true } : { name, active: true };
  }).filter((row) => row.name);
}

function optionNames(records, rawValue) {
  const names = records.filter((record) => record.active !== false).map((record) => record.name);
  return rawValue && !names.includes(rawValue) ? [rawValue, ...names] : names;
}

export default function InventoryManagementSystem() {
  const [session, setSession] = useState(null);
  const [profile, setProfile] = useState(null);
  const [profiles, setProfiles] = useState([]);
  const [section, setSection] = useState("Activities");
  const [warehouse, setWarehouse] = useState(ALL_WAREHOUSES);
  const [warehouses, setWarehouses] = useState([DEFAULT_WAREHOUSE]);
  const [activities, setActivities] = useState([]);
  const [inventoryLedger, setInventoryLedger] = useState([]);
  const [products, setProducts] = useState([]);
  const [customers, setCustomers] = useState([]);
  const [suppliers, setSuppliers] = useState([]);
  const [query, setQuery] = useState("");
  const [month, setMonth] = useState("");
  const [billingRates, setBillingRates] = useState({});
  const [chargeInvoices, setChargeInvoices] = useState({});
  const [chargeMonths, setChargeMonths] = useState([DEFAULT_CHARGE_MONTH]);
  const [authLoading, setAuthLoading] = useState(true);
  const [loading, setLoading] = useState(false);
  const [chargesLoading, setChargesLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");
  const [uploadingActivityId, setUploadingActivityId] = useState(null);
  const [uploadingInvoice, setUploadingInvoice] = useState(false);
  const [activitySort, setActivitySort] = useState({ key: "activity_date", direction: "desc" });
  const isOwner = profile?.role === "owner" || profile?.role === "admin";
  const activeWarehouses = warehouses.filter((warehouseRecord) => warehouseRecord.active);
  const assignedWarehouse = warehouses.find((warehouseRecord) => warehouseRecord.id === profile?.warehouse_id);
  const selectableWarehouses = isOwner ? activeWarehouses : activeWarehouses.filter((warehouseRecord) => warehouseRecord.id === profile?.warehouse_id);
  const defaultWarehouse = assignedWarehouse || activeWarehouses[0] || warehouses[0] || DEFAULT_WAREHOUSE;

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
        setProducts([]);
        setCustomers([]);
        setSuppliers([]);
        setProfiles([]);
        setWarehouses([DEFAULT_WAREHOUSE]);
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
    loadWarehouses(profile);
    loadMasterData();
    if (isOwner) {
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
      .select("id, email, role, warehouse, warehouse_id, warehouses:warehouse_id(id, code, name)")
      .eq("id", user.id)
      .single();

    if (error) {
      console.error(error);
      setErrorMessage("No profile is configured for this user.");
      setProfile(null);
      return;
    }

    const nextProfile = normalizeProfile(data);

    if (nextProfile.role === "warehouse") {
      setWarehouse(nextProfile.warehouse_id || nextProfile.warehouse_name);
      if (["Charges", "Settings", "Warehouses", "Products", "Customers", "Suppliers"].includes(section)) setSection("Activities");
    }

    setProfile(nextProfile);
  }

  async function loadProfiles() {
    const { data, error } = await supabase
      .from("profiles")
      .select("id, email, role, warehouse, warehouse_id, warehouses:warehouse_id(id, code, name)")
      .order("email", { ascending: true });

    if (error) {
      console.error(error);
      setErrorMessage("Settings loaded, but user profiles could not be loaded.");
    } else {
      setProfiles((data || []).map(normalizeProfile));
    }
  }

  async function loadWarehouses(activeProfile = profile) {
    let warehouseQuery = supabase
      .from("warehouses")
      .select("id, code, name, active, created_at")
      .order("name", { ascending: true });

    if (activeProfile?.role === "warehouse" && activeProfile.warehouse_id) {
      warehouseQuery = warehouseQuery.eq("id", activeProfile.warehouse_id);
    }

    const { data, error } = await warehouseQuery;

    if (error) {
      console.error(error);
      setErrorMessage("Warehouses could not be loaded.");
      setWarehouses([DEFAULT_WAREHOUSE]);
      return;
    }

    const nextWarehouses = (data || []).map(normalizeWarehouse);
    const safeWarehouses = nextWarehouses.length ? nextWarehouses : [DEFAULT_WAREHOUSE];
    setWarehouses(safeWarehouses);

    if (activeProfile?.role === "warehouse") {
      const selectedWarehouse = safeWarehouses.find((warehouseRecord) => warehouseRecord.id === activeProfile.warehouse_id);
      setWarehouse(selectedWarehouse?.id || activeProfile.warehouse_name || activeProfile.warehouse || DEFAULT_WAREHOUSE.name);
    }
  }

  async function loadMasterData() {
    const [productsResult, customersResult, suppliersResult] = await Promise.all([
      supabase.from("products").select("id, name, sku, active, created_at").order("name", { ascending: true }),
      supabase.from("customers").select("id, name, active, created_at").order("name", { ascending: true }),
      supabase.from("suppliers").select("id, name, active, created_at").order("name", { ascending: true }),
    ]);

    if (productsResult.error || customersResult.error || suppliersResult.error) {
      console.error(productsResult.error || customersResult.error || suppliersResult.error);
      setErrorMessage("Master data could not be loaded.");
      return;
    }

    setProducts(productsResult.data || []);
    setCustomers(customersResult.data || []);
    setSuppliers(suppliersResult.data || []);
  }

  async function loadActivities(activeProfile = profile) {
    if (!activeProfile) return;

    setLoading(true);
    setErrorMessage("");

    let activityQuery = supabase
      .from("activities")
      .select("*, warehouses:warehouse_id(id, code, name)")
      .order("activity_date", { ascending: false });

    if (activeProfile.role === "warehouse") {
      if (activeProfile.warehouse_id) {
        activityQuery = activityQuery.eq("warehouse_id", activeProfile.warehouse_id);
      } else {
        activityQuery = activityQuery.eq("warehouse", activeProfile.warehouse_name || activeProfile.warehouse);
      }
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
      if (activeProfile.warehouse_id) {
        ledgerQuery = ledgerQuery.eq("warehouse_id", activeProfile.warehouse_id);
      } else {
        ledgerQuery = ledgerQuery.eq("warehouse", activeProfile.warehouse_name || activeProfile.warehouse);
      }
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
      rowMatchesWarehouse(a, warehouse) &&
      JSON.stringify(a).toLowerCase().includes(query.toLowerCase()),
  );
  const sortedActivities = useMemo(() => {
    const direction = activitySort.direction === "asc" ? 1 : -1;
    return [...visibleActivities].sort((a, b) => {
      const aValue = a[activitySort.key] ?? "";
      const bValue = b[activitySort.key] ?? "";
      if (Number.isFinite(Number(aValue)) && Number.isFinite(Number(bValue))) {
        return (Number(aValue) - Number(bValue)) * direction;
      }
      return String(aValue).localeCompare(String(bValue)) * direction;
    });
  }, [activitySort, visibleActivities]);

  const palletBalances = useMemo(() => derivePalletBalances(activities), [activities]);
  const visibleInventory = useMemo(
    () => inventoryLedger
      .filter((i) => rowMatchesWarehouse(i, warehouse))
      .map((row) => ({
        ...row,
        pallets: palletBalances.get(inventoryKey(row.item, row.warehouse_id || row.warehouse)) || 0,
      })),
    [inventoryLedger, palletBalances, warehouse],
  );
  const visibleChargeMonths = useMemo(
    () => Array.from(new Set([
      ...chargeMonths,
      ...activities.map((activity) => monthLabelFromKey(toMonthKey(activity.activity_date))).filter(Boolean),
    ])).sort((a, b) => monthKeyFromLabel(b).localeCompare(monthKeyFromLabel(a))),
    [activities, chargeMonths],
  );
  const selectedChargeMonth = month || visibleChargeMonths[0] || DEFAULT_CHARGE_MONTH;
  const chargeMonthKey = monthKeyFromLabel(selectedChargeMonth);
  const charges = calculateCharges(
    chargeMonthKey,
    activities,
    billingRates[chargeMonthKey],
    chargeInvoices[chargeMonthKey] || [],
  );

  async function addEvent() {
    if (!profile) return;
    const selectedWarehouse =
      profile.role === "warehouse"
        ? assignedWarehouse || defaultWarehouse
        : warehouses.find((warehouseRecord) => warehouseRecord.id === warehouse) || defaultWarehouse;
    const payload = {
      activity_date: new Date().toISOString().slice(0, 10),
      warehouse_id: selectedWarehouse.id || null,
      warehouse: warehouseName(selectedWarehouse),
      pallets: 0,
      pieces: 0,
      product: "",
      customer: "",
      lot_number: "",
      supplier: "",
      repack: "",
      note: "",
    };

    const { data, error } = await supabase.from("activities").insert([payload]).select("*").single();

    if (error) {
      console.error(error);
      setErrorMessage("Insert failed in Supabase.");
      return;
    }

    setActivitySort({ key: "activity_date", direction: "desc" });
    setActivities((current) => [normalizeActivity(data), ...current]);
    await loadInventoryLedger();
  }

  async function updateActivity(activityId, field, value) {
    const numberFields = ["pallets", "pieces"];
    const selectedWarehouse = field === "warehouse_id" ? warehouses.find((warehouseRecord) => warehouseRecord.id === value) : null;
    const payload = field === "warehouse_id"
      ? { warehouse_id: selectedWarehouse?.id || null, warehouse: selectedWarehouse?.name || "" }
      : { [field]: numberFields.includes(field) ? Number(value || 0) : value };

    const { error } = await supabase.from("activities").update(payload).eq("id", activityId);

    if (error) {
      console.error(error);
      setErrorMessage("Activity update failed.");
      await loadActivities();
      return;
    }

    setActivities((current) =>
      current.map((activity) => activity.id === activityId ? { ...activity, ...payload } : activity),
    );

    if (["activity_date", "warehouse", "warehouse_id", "pallets", "pieces", "product"].includes(field)) {
      await loadInventoryLedger();
    }
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
      const activity = activities.find((currentActivity) => currentActivity.id === activityId);

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
          warehouse_id: activity?.warehouse_id || null,
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

  async function saveMasterRecord(kind, record) {
    const config = masterDataConfig[kind];
    const payload = config.hasSku
      ? { name: record.name, sku: record.sku || null, active: record.active !== false }
      : { name: record.name, active: record.active !== false };

    const query = record.id
      ? supabase.from(config.table).update(payload).eq("id", record.id)
      : supabase.from(config.table).insert([payload]);
    const { error } = await query;

    if (error) {
      console.error(error);
      setErrorMessage(`${kind} could not be saved.`);
      return;
    }

    await loadMasterData();
  }

  async function deleteMasterRecord(kind, record) {
    const config = masterDataConfig[kind];
    const { count, error: countError } = await supabase
      .from("activities")
      .select("id", { count: "exact", head: true })
      .eq(config.activityField, record.name);

    if (countError) {
      console.error(countError);
      setErrorMessage(`${kind} safety check failed.`);
      return;
    }

    if (count > 0) {
      setErrorMessage(`${record.name} is used by existing activities and cannot be deleted.`);
      return;
    }

    const { error } = await supabase.from(config.table).delete().eq("id", record.id);

    if (error) {
      console.error(error);
      setErrorMessage(`${kind} could not be deleted.`);
      return;
    }

    await loadMasterData();
  }

  async function importMasterCsv(kind, fileList) {
    const [file] = Array.from(fileList || []);
    if (!file) return;

    const config = masterDataConfig[kind];
    const text = await file.text();
    const rows = parseCsvNames(text, config.hasSku);
    if (rows.length === 0) return;

    const { error } = await supabase.from(config.table).insert(rows);

    if (error) {
      console.error(error);
      setErrorMessage(`${kind} CSV import failed.`);
      return;
    }

    await loadMasterData();
  }

  async function saveWarehouse(warehouseRecord) {
    const code = warehouseRecord.code.trim().toUpperCase();
    const name = warehouseRecord.name.trim();

    if (!code || !name) {
      setErrorMessage("Warehouse code and name are required.");
      return;
    }

    const payload = { code, name, active: warehouseRecord.active !== false };
    const request = warehouseRecord.id
      ? supabase.from("warehouses").update(payload).eq("id", warehouseRecord.id)
      : supabase.from("warehouses").insert([payload]);

    const { error } = await request;

    if (error) {
      console.error(error);
      setErrorMessage("Warehouse could not be saved.");
      return;
    }

    await loadWarehouses(profile);
    await loadActivities(profile);
    await loadInventoryLedger(profile);
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
          {isOwner && <NavButton key={ALL_WAREHOUSES} icon={<Warehouse size={18} />} active={section === "Inventory" && warehouse === ALL_WAREHOUSES} onClick={() => { setSection("Inventory"); setWarehouse(ALL_WAREHOUSES); }}>All warehouses</NavButton>}
          {selectableWarehouses.map((warehouseRecord) => <NavButton key={warehouseRecord.id || warehouseRecord.code} icon={<Warehouse size={18} />} active={section === "Inventory" && warehouse === warehouseRecord.id} onClick={() => { setSection("Inventory"); setWarehouse(warehouseRecord.id); }}>{warehouseRecord.name}</NavButton>)}

          {isOwner && <>
            <div className="mt-4 mb-2 text-xs font-semibold text-slate-400 uppercase">Charges</div>
            <NavButton icon={<DollarSign size={18} />} active={section === "Charges"} onClick={() => setSection("Charges")}>Charges</NavButton>

            <div className="mt-4 mb-2 text-xs font-semibold text-slate-400 uppercase">Settings</div>
            <NavButton icon={<Settings size={18} />} active={section === "Settings"} onClick={() => setSection("Settings")}>Users</NavButton>
            <NavButton icon={<Warehouse size={18} />} active={section === "Warehouses"} onClick={() => setSection("Warehouses")}>Warehouses</NavButton>
            <NavButton icon={<Settings size={18} />} active={section === "Products"} onClick={() => setSection("Products")}>Products</NavButton>
            <NavButton icon={<Settings size={18} />} active={section === "Customers"} onClick={() => setSection("Customers")}>Customers</NavButton>
            <NavButton icon={<Settings size={18} />} active={section === "Suppliers"} onClick={() => setSection("Suppliers")}>Suppliers</NavButton>
          </>}

          <div className="mt-8 pt-4 border-t border-slate-200">
            <Button variant="outline" className="w-full" onClick={() => supabase.auth.signOut()}><LogOut size={16} className="mr-2" />Log out</Button>
          </div>
        </aside>

        <main className="flex-1 p-8">
          <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}>
            {errorMessage && <div className="mb-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{errorMessage}</div>}
            {section === "Activities" && <ActivitiesView {...{ activities: sortedActivities, query, setQuery, addEvent, updateActivity, deleteActivity, uploadDocuments, uploadingActivityId, loading, activitySort, setActivitySort, products, customers, suppliers, warehouses: selectableWarehouses, isOwner }} />}
            {section === "Inventory" && <InventoryView warehouse={warehouse === ALL_WAREHOUSES ? ALL_WAREHOUSES : warehouses.find((warehouseRecord) => warehouseRecord.id === warehouse)?.name || warehouse} rows={visibleInventory} />}
            {section === "Charges" && isOwner && <ChargesView month={selectedChargeMonth} months={visibleChargeMonths} setMonth={setMonth} charges={charges} loading={chargesLoading} uploadingInvoice={uploadingInvoice} onSaveRates={saveBillingRates} onUploadInvoices={uploadChargeInvoices} />}
            {section === "Settings" && isOwner && <SettingsView profiles={profiles} />}
            {section === "Warehouses" && isOwner && <WarehouseSettings warehouses={warehouses} saveWarehouse={saveWarehouse} />}
            {section === "Products" && isOwner && <MasterDataView kind="Products" records={products} hasSku onSave={saveMasterRecord} onDelete={deleteMasterRecord} onImport={importMasterCsv} />}
            {section === "Customers" && isOwner && <MasterDataView kind="Customers" records={customers} onSave={saveMasterRecord} onDelete={deleteMasterRecord} onImport={importMasterCsv} />}
            {section === "Suppliers" && isOwner && <MasterDataView kind="Suppliers" records={suppliers} onSave={saveMasterRecord} onDelete={deleteMasterRecord} onImport={importMasterCsv} />}
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

function ActivitiesView({ activities, query, setQuery, addEvent, updateActivity, deleteActivity, uploadDocuments, uploadingActivityId, loading, activitySort, setActivitySort, products, customers, suppliers, warehouses, isOwner }) {
  const columns = [
    ["activity_date", "Date"],
    ["warehouse", "Warehouse"],
    ["pallets", "Pallet"],
    ["pieces", "Pieces"],
    ["product", "Product"],
    ["customer", "Customer"],
    ["lot_number", "Lot Number"],
    ["supplier", "Supplier"],
    ["repack", "Repack"],
    ["note", "Note"],
    ["docs", "Docs"],
    ["delete", "Delete"],
  ];
  const sortable = new Set(["activity_date", "warehouse", "pallets", "pieces", "product", "customer", "supplier", "lot_number", "repack"]);

  function toggleSort(key) {
    if (!sortable.has(key)) return;
    setActivitySort((current) => ({
      key,
      direction: current.key === key && current.direction === "asc" ? "desc" : "asc",
    }));
  }

  return <>
    <Header title="Activities" subtitle="Inbound, outbound, repack, notes, and documents per event." />
    <div className="flex items-center gap-3 mb-4">
      <div className="relative flex-1"><Search size={18} className="absolute left-3 top-3 text-slate-400" /><input className="w-full pl-10 pr-3 py-2 rounded-xl border bg-white" placeholder="Search activities..." value={query} onChange={(e) => setQuery(e.target.value)} /></div>
      <Button onClick={addEvent} className="rounded-xl"><Plus size={16} className="mr-2" />Add Event</Button>
    </div>

    {loading ? (
      <div className="rounded-2xl border bg-white p-6 text-sm text-slate-500 shadow-sm">Loading activities...</div>
    ) : (
      <div className="overflow-hidden rounded-2xl border bg-white shadow-sm">
        <table className="w-full text-sm">
          <thead className="bg-slate-100 text-slate-600">
            <tr>
              {columns.map(([key, label]) => (
                <th key={key} className="text-left px-4 py-3 font-semibold">
                  <button className={sortable.has(key) ? "font-semibold hover:text-slate-900" : "font-semibold"} onClick={() => toggleSort(key)}>
                    {label}{activitySort.key === key ? activitySort.direction === "asc" ? " ↑" : " ↓" : ""}
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {activities.map((activity) => (
              <tr key={activity.id} className="border-t hover:bg-slate-50">
                <td className="px-4 py-3 align-top"><EditableCell type="date" value={activity.activity_date} onSave={(value) => updateActivity(activity.id, "activity_date", value)} /></td>
                <td className="px-4 py-3 align-top"><EditableCell type="select" disabled={!isOwner} value={activity.warehouse_id || ""} displayValue={getActivityWarehouseName(activity)} options={warehouses.map((warehouseRecord) => ({ value: warehouseRecord.id, label: warehouseLabel(warehouseRecord) }))} onSave={(value) => updateActivity(activity.id, "warehouse_id", value)} /></td>
                <td className="px-4 py-3 align-top"><EditableCell type="number" value={activity.pallets} onSave={(value) => updateActivity(activity.id, "pallets", value)} /></td>
                <td className="px-4 py-3 align-top"><EditableCell type="number" value={activity.pieces} onSave={(value) => updateActivity(activity.id, "pieces", value)} /></td>
                <td className="px-4 py-3 align-top"><EditableCell type="select" value={activity.product} options={optionNames(products, activity.product)} onSave={(value) => updateActivity(activity.id, "product", value)} /></td>
                <td className="px-4 py-3 align-top"><EditableCell type="select" value={activity.customer} options={optionNames(customers, activity.customer)} onSave={(value) => updateActivity(activity.id, "customer", value)} /></td>
                <td className="px-4 py-3 align-top"><EditableCell value={activity.lot_number} onSave={(value) => updateActivity(activity.id, "lot_number", value)} /></td>
                <td className="px-4 py-3 align-top"><EditableCell type="select" value={activity.supplier} options={optionNames(suppliers, activity.supplier)} onSave={(value) => updateActivity(activity.id, "supplier", value)} /></td>
                <td className="px-4 py-3 align-top"><EditableCell type="select" value={activity.repack} options={["", "Y", "N"]} onSave={(value) => updateActivity(activity.id, "repack", value)} /></td>
                <td className="px-4 py-3 align-top"><EditableCell value={activity.note} onSave={(value) => updateActivity(activity.id, "note", value)} /></td>
                <td className="px-4 py-3 align-top"><DocUpload documents={activity.documents} uploading={uploadingActivityId === activity.id} onChange={(files) => uploadDocuments(activity.id, files)} /></td>
                <td className="px-4 py-3 align-top"><Button size="sm" variant="ghost" onClick={() => deleteActivity(activity.id)}><Trash2 size={16} /></Button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    )}
  </>;
}

function EditableCell({ value = "", displayValue, type = "text", options = [], disabled = false, onSave }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value ?? "");

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setDraft(value ?? "");
  }, [value]);

  async function save() {
    setEditing(false);
    if (String(draft ?? "") !== String(value ?? "")) await onSave(draft);
  }

  if (!editing) {
    return <button className="min-h-6 w-full text-left disabled:cursor-not-allowed" disabled={disabled} onClick={() => setEditing(true)}>{displayValue || value || "-"}</button>;
  }

  if (type === "select") {
    return (
      <select className="w-full rounded border px-2 py-1" autoFocus value={draft} onChange={(event) => setDraft(event.target.value)} onBlur={save} onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }}>
        <option value=""></option>
        {options.map((option) => {
          const optionValue = typeof option === "object" ? option.value : option;
          const optionLabel = typeof option === "object" ? option.label : option;
          return <option key={optionValue} value={optionValue}>{optionLabel}</option>;
        })}
      </select>
    );
  }

  return (
    <input className="w-full rounded border px-2 py-1" autoFocus type={type} value={draft} onChange={(event) => setDraft(event.target.value)} onBlur={save} onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }} />
  );
}

function InventoryView({ warehouse, rows }) {
  return <>
    <Header title={`Inventory — ${warehouse}`} />
    <Table headers={["Item", "Pallets", "Pcs", "Reserved", "Incoming"]} rows={rows.map((r) => [r.item, r.pallets, r.in_qty, r.reserved_qty, r.incoming_qty])} />
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

function MasterDataView({ kind, records, hasSku = false, onSave, onDelete, onImport }) {
  const emptyRecord = hasSku ? { name: "", sku: "", active: true } : { name: "", active: true };
  const [newRecord, setNewRecord] = useState(emptyRecord);
  const [editingRows, setEditingRows] = useState({});

  function updateRow(record, patch) {
    setEditingRows((current) => ({
      ...current,
      [record.id]: { ...record, ...(current[record.id] || {}), ...patch },
    }));
  }

  async function saveNew() {
    if (!newRecord.name) return;
    await onSave(kind, newRecord);
    setNewRecord(emptyRecord);
  }

  return <>
    <Header title={`Settings - ${kind}`} subtitle="Owner-managed master data for activity entry." />
    <Card className="rounded-2xl shadow-sm mb-6"><CardContent className="p-5">
      <div className={`grid gap-3 ${hasSku ? "grid-cols-5" : "grid-cols-4"}`}>
        <Input label="Name" value={newRecord.name} onChange={(value) => setNewRecord({ ...newRecord, name: value })} />
        {hasSku && <Input label="SKU" value={newRecord.sku} onChange={(value) => setNewRecord({ ...newRecord, sku: value })} />}
        <Select label="Active" value={newRecord.active ? "true" : "false"} onChange={(value) => setNewRecord({ ...newRecord, active: value === "true" })} options={["true", "false"]} />
        <div className="flex items-end"><Button onClick={saveNew} className="w-full"><Plus size={16} className="mr-2" />Add</Button></div>
        <label className="inline-flex cursor-pointer items-end justify-center rounded-xl border border-slate-300 bg-white px-4 py-2 text-sm font-medium transition hover:bg-slate-100">
          <Upload size={16} className="mr-2" />Import CSV
          <input type="file" accept=".csv,text/csv" className="hidden" onChange={(event) => onImport(kind, event.target.files)} />
        </label>
      </div>
    </CardContent></Card>
    <div className="overflow-hidden rounded-2xl border bg-white shadow-sm">
      <table className="w-full text-sm">
        <thead className="bg-slate-100 text-slate-600">
          <tr>
            <th className="text-left px-4 py-3 font-semibold">Name</th>
            {hasSku && <th className="text-left px-4 py-3 font-semibold">SKU</th>}
            <th className="text-left px-4 py-3 font-semibold">Active</th>
            <th className="text-left px-4 py-3 font-semibold">Actions</th>
          </tr>
        </thead>
        <tbody>
          {records.map((record) => {
            const draft = editingRows[record.id] || record;
            return (
              <tr key={record.id} className="border-t hover:bg-slate-50">
                <td className="px-4 py-3"><input className="w-full rounded border px-2 py-1" value={draft.name || ""} onChange={(event) => updateRow(record, { name: event.target.value })} /></td>
                {hasSku && <td className="px-4 py-3"><input className="w-full rounded border px-2 py-1" value={draft.sku || ""} onChange={(event) => updateRow(record, { sku: event.target.value })} /></td>}
                <td className="px-4 py-3"><select className="rounded border px-2 py-1" value={draft.active === false ? "false" : "true"} onChange={(event) => updateRow(record, { active: event.target.value === "true" })}><option value="true">Active</option><option value="false">Inactive</option></select></td>
                <td className="px-4 py-3">
                  <div className="flex gap-2">
                    <Button size="sm" onClick={() => onSave(kind, draft)}>Save</Button>
                    <Button size="sm" variant="ghost" onClick={() => onDelete(kind, record)}><Trash2 size={16} /></Button>
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  </>;
}

function WarehouseSettings({ warehouses, saveWarehouse }) {
  const [newWarehouse, setNewWarehouse] = useState({ code: "", name: "", active: true });
  const [editingRows, setEditingRows] = useState({});

  function updateRow(warehouseRecord, patch) {
    setEditingRows((current) => ({
      ...current,
      [warehouseRecord.id]: { ...warehouseRecord, ...(current[warehouseRecord.id] || {}), ...patch },
    }));
  }

  async function saveNew() {
    if (!newWarehouse.code || !newWarehouse.name) return;
    await saveWarehouse(newWarehouse);
    setNewWarehouse({ code: "", name: "", active: true });
  }

  return <>
    <Header title="Settings - Warehouses" subtitle="Owner-managed warehouse codes, names, and active status." />
    <Card className="rounded-2xl shadow-sm mb-6"><CardContent className="p-5">
      <div className="grid grid-cols-4 gap-3">
        <Input label="Code" value={newWarehouse.code} onChange={(value) => setNewWarehouse({ ...newWarehouse, code: value })} />
        <Input label="Name" value={newWarehouse.name} onChange={(value) => setNewWarehouse({ ...newWarehouse, name: value })} />
        <Select label="Active" value={newWarehouse.active ? "true" : "false"} onChange={(value) => setNewWarehouse({ ...newWarehouse, active: value === "true" })} options={["true", "false"]} />
        <div className="flex items-end"><Button onClick={saveNew} className="w-full"><Plus size={16} className="mr-2" />Add warehouse</Button></div>
      </div>
    </CardContent></Card>

    <div className="overflow-hidden rounded-2xl border bg-white shadow-sm">
      <table className="w-full text-sm">
        <thead className="bg-slate-100 text-slate-600">
          <tr>
            <th className="text-left px-4 py-3 font-semibold">Code</th>
            <th className="text-left px-4 py-3 font-semibold">Name</th>
            <th className="text-left px-4 py-3 font-semibold">Active</th>
            <th className="text-left px-4 py-3 font-semibold">Actions</th>
          </tr>
        </thead>
        <tbody>
          {warehouses.map((warehouseRecord) => {
            const draft = editingRows[warehouseRecord.id] || warehouseRecord;
            return (
              <tr key={warehouseRecord.id || warehouseRecord.code} className="border-t hover:bg-slate-50">
                <td className="px-4 py-3"><input className="w-full rounded border px-2 py-1" value={draft.code || ""} onChange={(event) => updateRow(warehouseRecord, { code: event.target.value })} /></td>
                <td className="px-4 py-3"><input className="w-full rounded border px-2 py-1" value={draft.name || ""} onChange={(event) => updateRow(warehouseRecord, { name: event.target.value })} /></td>
                <td className="px-4 py-3"><select className="rounded border px-2 py-1" value={draft.active === false ? "false" : "true"} onChange={(event) => updateRow(warehouseRecord, { active: event.target.value === "true" })}><option value="true">Active</option><option value="false">Inactive</option></select></td>
                <td className="px-4 py-3"><Button size="sm" onClick={() => saveWarehouse(draft)}><Save size={14} className="mr-2" />Save</Button></td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  </>;
}

function SettingsView({ profiles }) {
  return <>
    <Header title="Settings - Users" subtitle="Owner and warehouse-level user access." />
    <Card className="rounded-2xl shadow-sm"><CardContent className="p-5"><Table headers={["User", "Role", "Access"]} rows={profiles.map((user) => [user.email, user.role, user.role === "owner" ? "All warehouses + charges + settings" : `${user.warehouse_name || user.warehouse} activities and inventory only`])} /></CardContent></Card>
  </>;
}

function Header({ title, subtitle }) { return <div className="mb-6"><h1 className="text-3xl font-bold tracking-tight">{title}</h1>{subtitle && <p className="text-slate-500 mt-1">{subtitle}</p>}</div>; }
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
