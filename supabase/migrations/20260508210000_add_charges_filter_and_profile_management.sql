alter table if exists public.profiles
  add column if not exists active boolean default true,
  add column if not exists created_at timestamptz default now(),
  add column if not exists warehouse_id uuid references public.warehouses(id);

alter table if exists public.profiles
  drop constraint if exists profiles_role_check,
  drop constraint if exists profiles_check;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'profiles_role_check'
      and conrelid = 'public.profiles'::regclass
  ) then
    alter table public.profiles
      add constraint profiles_role_check check (role in ('owner', 'admin', 'warehouse'));
  end if;
end $$;

alter table if exists public.documents
  add column if not exists warehouse_id uuid references public.warehouses(id);

alter table if exists public.charges
  add column if not exists warehouse_id uuid references public.warehouses(id);

alter table if exists public.charge_invoices
  add column if not exists warehouse_id uuid references public.warehouses(id);

alter table if exists public.monthly_charge_summaries
  add column if not exists warehouse_id uuid references public.warehouses(id);

update public.profiles
set warehouse_id = warehouses.id
from public.warehouses
where profiles.warehouse_id is null
  and (profiles.warehouse = warehouses.name or profiles.warehouse = warehouses.code);

update public.documents
set warehouse_id = activities.warehouse_id
from public.activities
where documents.warehouse_id is null
  and documents.activity_id = activities.id
  and activities.warehouse_id is not null;

update public.charges
set warehouse_id = warehouses.id
from public.warehouses
where charges.warehouse_id is null
  and (charges.warehouse = warehouses.name or charges.warehouse = warehouses.code);

create index if not exists profiles_active_idx on public.profiles(active);
create index if not exists profiles_warehouse_id_idx on public.profiles(warehouse_id);
create index if not exists documents_warehouse_id_idx on public.documents(warehouse_id);
create index if not exists charges_warehouse_id_idx on public.charges(warehouse_id);
create index if not exists charge_invoices_warehouse_id_idx on public.charge_invoices(warehouse_id);
create index if not exists monthly_charge_summaries_warehouse_id_idx on public.monthly_charge_summaries(warehouse_id);

create or replace function public.current_user_is_active()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.profiles
    where id = auth.uid()
      and active = true
  )
$$;

create or replace function public.current_user_role()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select role
  from public.profiles
  where id = auth.uid()
    and active = true
$$;

create or replace function public.current_profile_role()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select public.current_user_role()
$$;

create or replace function public.current_profile_warehouse()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(w.name, p.warehouse)
  from public.profiles p
  left join public.warehouses w on w.id = p.warehouse_id
  where p.id = auth.uid()
    and p.active = true
$$;

create or replace function public.current_user_is_owner()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(public.current_user_role() in ('owner', 'admin'), false)
$$;

create or replace function public.current_user_warehouse_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select warehouse_id
  from public.profiles
  where id = auth.uid()
    and active = true
$$;

create or replace function public.user_can_access_warehouse(target_warehouse_id uuid, target_warehouse_name text default null)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.current_user_is_owner()
    or target_warehouse_id = public.current_user_warehouse_id()
    or (
      target_warehouse_id is null
      and target_warehouse_name is not null
      and exists (
        select 1
        from public.profiles p
        left join public.warehouses w on w.id = p.warehouse_id
        where p.id = auth.uid()
          and p.active = true
          and (target_warehouse_name = p.warehouse or target_warehouse_name = w.name or target_warehouse_name = w.code)
      )
    )
$$;

create or replace function public.can_access_warehouse(target_warehouse text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.user_can_access_warehouse(null, target_warehouse)
$$;

alter table public.profiles enable row level security;
alter table public.warehouses enable row level security;
alter table public.activities enable row level security;
alter table public.documents enable row level security;
alter table public.products enable row level security;
alter table public.customers enable row level security;
alter table public.suppliers enable row level security;
alter table if exists public.inventory_items enable row level security;
alter table public.billing_rates enable row level security;
alter table public.charges enable row level security;
alter table public.charge_invoices enable row level security;
alter table public.monthly_charge_summaries enable row level security;

alter view if exists public.inventory_ledger set (security_invoker = true);
alter view if exists public.inventory_summary set (security_invoker = true);

drop policy if exists "profiles_select_scoped" on public.profiles;
drop policy if exists "profiles_insert_owner" on public.profiles;
drop policy if exists "profiles_update_owner" on public.profiles;
drop policy if exists "profiles_delete_owner" on public.profiles;
drop policy if exists "profiles_select_active" on public.profiles;
drop policy if exists "profiles_insert_admin" on public.profiles;
drop policy if exists "profiles_update_admin" on public.profiles;
drop policy if exists "profiles_delete_admin" on public.profiles;

create policy "profiles_select_active"
on public.profiles for select
to authenticated
using (public.current_user_is_owner() or (id = auth.uid() and active = true));

create policy "profiles_insert_admin"
on public.profiles for insert
to authenticated
with check (public.current_user_is_owner());

create policy "profiles_update_admin"
on public.profiles for update
to authenticated
using (public.current_user_is_owner())
with check (public.current_user_is_owner());

create policy "profiles_delete_admin"
on public.profiles for delete
to authenticated
using (public.current_user_is_owner());

drop policy if exists "warehouses_select_active" on public.warehouses;
drop policy if exists "warehouses_insert_owner" on public.warehouses;
drop policy if exists "warehouses_update_owner" on public.warehouses;
drop policy if exists "warehouses_delete_owner" on public.warehouses;

create policy "warehouses_select_active"
on public.warehouses for select
to authenticated
using (public.current_user_is_active() and (active = true or public.current_user_is_owner()));

create policy "warehouses_insert_owner"
on public.warehouses for insert
to authenticated
with check (public.current_user_is_owner());

create policy "warehouses_update_owner"
on public.warehouses for update
to authenticated
using (public.current_user_is_owner())
with check (public.current_user_is_owner());

create policy "warehouses_delete_owner"
on public.warehouses for delete
to authenticated
using (public.current_user_is_owner());

drop policy if exists "activities_select_scoped" on public.activities;
drop policy if exists "activities_insert_scoped" on public.activities;
drop policy if exists "activities_update_scoped" on public.activities;
drop policy if exists "activities_delete_scoped" on public.activities;
drop policy if exists "Users can read assigned activities" on public.activities;
drop policy if exists "Users can insert assigned activities" on public.activities;
drop policy if exists "Users can update assigned activities" on public.activities;
drop policy if exists "Users can delete assigned activities" on public.activities;

create policy "activities_select_scoped"
on public.activities for select
to authenticated
using (public.user_can_access_warehouse(warehouse_id, warehouse));

create policy "activities_insert_scoped"
on public.activities for insert
to authenticated
with check (public.user_can_access_warehouse(warehouse_id, warehouse));

create policy "activities_update_scoped"
on public.activities for update
to authenticated
using (public.user_can_access_warehouse(warehouse_id, warehouse))
with check (public.user_can_access_warehouse(warehouse_id, warehouse));

create policy "activities_delete_scoped"
on public.activities for delete
to authenticated
using (public.user_can_access_warehouse(warehouse_id, warehouse));

drop policy if exists "documents_select_scoped" on public.documents;
drop policy if exists "documents_insert_scoped" on public.documents;
drop policy if exists "documents_update_scoped" on public.documents;
drop policy if exists "documents_delete_scoped" on public.documents;
drop policy if exists "Users can read assigned documents" on public.documents;
drop policy if exists "Users can manage assigned documents" on public.documents;

create policy "documents_select_scoped"
on public.documents for select
to authenticated
using (
  public.user_can_access_warehouse(warehouse_id)
  or exists (
    select 1 from public.activities a
    where a.id = documents.activity_id
      and public.user_can_access_warehouse(a.warehouse_id, a.warehouse)
  )
);

create policy "documents_insert_scoped"
on public.documents for insert
to authenticated
with check (
  public.user_can_access_warehouse(warehouse_id)
  or exists (
    select 1 from public.activities a
    where a.id = documents.activity_id
      and public.user_can_access_warehouse(a.warehouse_id, a.warehouse)
  )
);

create policy "documents_update_scoped"
on public.documents for update
to authenticated
using (public.user_can_access_warehouse(warehouse_id))
with check (public.user_can_access_warehouse(warehouse_id));

create policy "documents_delete_scoped"
on public.documents for delete
to authenticated
using (public.user_can_access_warehouse(warehouse_id));

drop policy if exists "Users can read assigned inventory" on public.inventory_items;
drop policy if exists "Users can manage assigned inventory" on public.inventory_items;
drop policy if exists "inventory_items_select_scoped" on public.inventory_items;
drop policy if exists "inventory_items_insert_scoped" on public.inventory_items;
drop policy if exists "inventory_items_update_scoped" on public.inventory_items;
drop policy if exists "inventory_items_delete_scoped" on public.inventory_items;

create policy "inventory_items_select_scoped"
on public.inventory_items for select
to authenticated
using (public.user_can_access_warehouse(warehouse_id, warehouse));

create policy "inventory_items_insert_scoped"
on public.inventory_items for insert
to authenticated
with check (public.user_can_access_warehouse(warehouse_id, warehouse));

create policy "inventory_items_update_scoped"
on public.inventory_items for update
to authenticated
using (public.user_can_access_warehouse(warehouse_id, warehouse))
with check (public.user_can_access_warehouse(warehouse_id, warehouse));

create policy "inventory_items_delete_scoped"
on public.inventory_items for delete
to authenticated
using (public.user_can_access_warehouse(warehouse_id, warehouse));

drop policy if exists "products_select_scoped" on public.products;
drop policy if exists "products_insert_owner" on public.products;
drop policy if exists "products_update_owner" on public.products;
drop policy if exists "products_delete_owner" on public.products;
drop policy if exists "customers_select_scoped" on public.customers;
drop policy if exists "customers_insert_owner" on public.customers;
drop policy if exists "customers_update_owner" on public.customers;
drop policy if exists "customers_delete_owner" on public.customers;
drop policy if exists "suppliers_select_scoped" on public.suppliers;
drop policy if exists "suppliers_insert_owner" on public.suppliers;
drop policy if exists "suppliers_update_owner" on public.suppliers;
drop policy if exists "suppliers_delete_owner" on public.suppliers;

create policy "products_select_scoped"
on public.products for select
to authenticated
using (public.current_user_is_active() and (active = true or public.current_user_is_owner()));

create policy "products_insert_owner"
on public.products for insert
to authenticated
with check (public.current_user_is_owner());

create policy "products_update_owner"
on public.products for update
to authenticated
using (public.current_user_is_owner())
with check (public.current_user_is_owner());

create policy "products_delete_owner"
on public.products for delete
to authenticated
using (public.current_user_is_owner());

create policy "customers_select_scoped"
on public.customers for select
to authenticated
using (public.current_user_is_active() and (active = true or public.current_user_is_owner()));

create policy "customers_insert_owner"
on public.customers for insert
to authenticated
with check (public.current_user_is_owner());

create policy "customers_update_owner"
on public.customers for update
to authenticated
using (public.current_user_is_owner())
with check (public.current_user_is_owner());

create policy "customers_delete_owner"
on public.customers for delete
to authenticated
using (public.current_user_is_owner());

create policy "suppliers_select_scoped"
on public.suppliers for select
to authenticated
using (public.current_user_is_active() and (active = true or public.current_user_is_owner()));

create policy "suppliers_insert_owner"
on public.suppliers for insert
to authenticated
with check (public.current_user_is_owner());

create policy "suppliers_update_owner"
on public.suppliers for update
to authenticated
using (public.current_user_is_owner())
with check (public.current_user_is_owner());

create policy "suppliers_delete_owner"
on public.suppliers for delete
to authenticated
using (public.current_user_is_owner());

drop policy if exists "billing_rates_select_owner" on public.billing_rates;
drop policy if exists "billing_rates_insert_owner" on public.billing_rates;
drop policy if exists "billing_rates_update_owner" on public.billing_rates;
drop policy if exists "billing_rates_delete_owner" on public.billing_rates;
drop policy if exists "billing_rates_select_active" on public.billing_rates;
drop policy if exists "billing_rates_insert_admin" on public.billing_rates;
drop policy if exists "billing_rates_update_admin" on public.billing_rates;
drop policy if exists "billing_rates_delete_admin" on public.billing_rates;

create policy "billing_rates_select_active"
on public.billing_rates for select
to authenticated
using (public.current_user_is_active());

create policy "billing_rates_insert_admin"
on public.billing_rates for insert
to authenticated
with check (public.current_user_is_owner());

create policy "billing_rates_update_admin"
on public.billing_rates for update
to authenticated
using (public.current_user_is_owner())
with check (public.current_user_is_owner());

create policy "billing_rates_delete_admin"
on public.billing_rates for delete
to authenticated
using (public.current_user_is_owner());

drop policy if exists "Users can read assigned charges" on public.charges;
drop policy if exists "Owners can manage charges" on public.charges;
drop policy if exists "charges_select_scoped" on public.charges;
drop policy if exists "charges_insert_scoped" on public.charges;
drop policy if exists "charges_update_scoped" on public.charges;
drop policy if exists "charges_delete_scoped" on public.charges;

create policy "charges_select_scoped"
on public.charges for select
to authenticated
using (public.user_can_access_warehouse(warehouse_id, warehouse));

create policy "charges_insert_scoped"
on public.charges for insert
to authenticated
with check (public.user_can_access_warehouse(warehouse_id, warehouse));

create policy "charges_update_scoped"
on public.charges for update
to authenticated
using (public.user_can_access_warehouse(warehouse_id, warehouse))
with check (public.user_can_access_warehouse(warehouse_id, warehouse));

create policy "charges_delete_scoped"
on public.charges for delete
to authenticated
using (public.user_can_access_warehouse(warehouse_id, warehouse));

drop policy if exists "charge_invoices_select_owner" on public.charge_invoices;
drop policy if exists "charge_invoices_insert_owner" on public.charge_invoices;
drop policy if exists "charge_invoices_update_owner" on public.charge_invoices;
drop policy if exists "charge_invoices_delete_owner" on public.charge_invoices;
drop policy if exists "charge_invoices_select_scoped" on public.charge_invoices;
drop policy if exists "charge_invoices_insert_scoped" on public.charge_invoices;
drop policy if exists "charge_invoices_update_scoped" on public.charge_invoices;
drop policy if exists "charge_invoices_delete_scoped" on public.charge_invoices;

create policy "charge_invoices_select_scoped"
on public.charge_invoices for select
to authenticated
using (public.current_user_is_owner() or public.user_can_access_warehouse(warehouse_id));

create policy "charge_invoices_insert_scoped"
on public.charge_invoices for insert
to authenticated
with check (public.current_user_is_owner() or public.user_can_access_warehouse(warehouse_id));

create policy "charge_invoices_update_scoped"
on public.charge_invoices for update
to authenticated
using (public.current_user_is_owner() or public.user_can_access_warehouse(warehouse_id))
with check (public.current_user_is_owner() or public.user_can_access_warehouse(warehouse_id));

create policy "charge_invoices_delete_scoped"
on public.charge_invoices for delete
to authenticated
using (public.current_user_is_owner() or public.user_can_access_warehouse(warehouse_id));

drop policy if exists "monthly_charge_summaries_select_owner" on public.monthly_charge_summaries;
drop policy if exists "monthly_charge_summaries_insert_owner" on public.monthly_charge_summaries;
drop policy if exists "monthly_charge_summaries_update_owner" on public.monthly_charge_summaries;
drop policy if exists "monthly_charge_summaries_delete_owner" on public.monthly_charge_summaries;
drop policy if exists "monthly_charge_summaries_select_scoped" on public.monthly_charge_summaries;
drop policy if exists "monthly_charge_summaries_insert_scoped" on public.monthly_charge_summaries;
drop policy if exists "monthly_charge_summaries_update_scoped" on public.monthly_charge_summaries;
drop policy if exists "monthly_charge_summaries_delete_scoped" on public.monthly_charge_summaries;

create policy "monthly_charge_summaries_select_scoped"
on public.monthly_charge_summaries for select
to authenticated
using (public.current_user_is_owner() or public.user_can_access_warehouse(warehouse_id));

create policy "monthly_charge_summaries_insert_scoped"
on public.monthly_charge_summaries for insert
to authenticated
with check (public.current_user_is_owner() or public.user_can_access_warehouse(warehouse_id));

create policy "monthly_charge_summaries_update_scoped"
on public.monthly_charge_summaries for update
to authenticated
using (public.current_user_is_owner() or public.user_can_access_warehouse(warehouse_id))
with check (public.current_user_is_owner() or public.user_can_access_warehouse(warehouse_id));

create policy "monthly_charge_summaries_delete_scoped"
on public.monthly_charge_summaries for delete
to authenticated
using (public.current_user_is_owner() or public.user_can_access_warehouse(warehouse_id));

drop policy if exists "charge_invoices_storage_select_owner" on storage.objects;
drop policy if exists "charge_invoices_storage_insert_owner" on storage.objects;
drop policy if exists "charge_invoices_storage_update_owner" on storage.objects;
drop policy if exists "charge_invoices_storage_delete_owner" on storage.objects;
drop policy if exists "charge_invoices_storage_select_scoped" on storage.objects;
drop policy if exists "charge_invoices_storage_insert_scoped" on storage.objects;
drop policy if exists "charge_invoices_storage_update_scoped" on storage.objects;
drop policy if exists "charge_invoices_storage_delete_scoped" on storage.objects;

create policy "charge_invoices_storage_select_scoped"
on storage.objects for select
to authenticated
using (
  bucket_id = 'charge-invoices'
  and (
    public.current_user_is_owner()
    or (storage.foldername(name))[1] = public.current_user_warehouse_id()::text
  )
);

create policy "charge_invoices_storage_insert_scoped"
on storage.objects for insert
to authenticated
with check (
  bucket_id = 'charge-invoices'
  and (
    public.current_user_is_owner()
    or (storage.foldername(name))[1] = public.current_user_warehouse_id()::text
  )
);

create policy "charge_invoices_storage_update_scoped"
on storage.objects for update
to authenticated
using (
  bucket_id = 'charge-invoices'
  and (
    public.current_user_is_owner()
    or (storage.foldername(name))[1] = public.current_user_warehouse_id()::text
  )
)
with check (
  bucket_id = 'charge-invoices'
  and (
    public.current_user_is_owner()
    or (storage.foldername(name))[1] = public.current_user_warehouse_id()::text
  )
);

create policy "charge_invoices_storage_delete_scoped"
on storage.objects for delete
to authenticated
using (
  bucket_id = 'charge-invoices'
  and (
    public.current_user_is_owner()
    or (storage.foldername(name))[1] = public.current_user_warehouse_id()::text
  )
);
