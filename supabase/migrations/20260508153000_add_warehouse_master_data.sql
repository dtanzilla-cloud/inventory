create extension if not exists "pgcrypto";

create table if not exists public.warehouses (
  id uuid primary key default gen_random_uuid(),
  code text unique not null,
  name text not null,
  active boolean default true,
  created_at timestamptz default now()
);

insert into public.warehouses (code, name, active)
values ('WH-A', 'Warehouse A', true)
on conflict (code) do update
set name = excluded.name,
    active = excluded.active;

alter table if exists public.profiles
  add column if not exists role text default 'warehouse',
  add column if not exists warehouse text,
  add column if not exists warehouse_id uuid references public.warehouses(id);

alter table if exists public.activities
  add column if not exists warehouse text,
  add column if not exists warehouse_id uuid references public.warehouses(id);

alter table if exists public.documents
  add column if not exists activity_id uuid references public.activities(id),
  add column if not exists warehouse_id uuid references public.warehouses(id);

alter table if exists public.inventory_items
  add column if not exists warehouse text,
  add column if not exists warehouse_id uuid references public.warehouses(id);

alter table if exists public.charges
  add column if not exists warehouse text,
  add column if not exists warehouse_id uuid references public.warehouses(id);

update public.activities
set warehouse_id = warehouses.id
from public.warehouses
where activities.warehouse_id is null
  and (activities.warehouse = warehouses.name or activities.warehouse = warehouses.code);

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

update public.inventory_items
set warehouse_id = warehouses.id
from public.warehouses
where inventory_items.warehouse_id is null
  and (inventory_items.warehouse = warehouses.name or inventory_items.warehouse = warehouses.code);

update public.charges
set warehouse_id = warehouses.id
from public.warehouses
where charges.warehouse_id is null
  and (charges.warehouse = warehouses.name or charges.warehouse = warehouses.code);

create index if not exists profiles_warehouse_id_idx on public.profiles(warehouse_id);
create index if not exists activities_warehouse_id_idx on public.activities(warehouse_id);
create index if not exists documents_warehouse_id_idx on public.documents(warehouse_id);
create index if not exists inventory_items_warehouse_id_idx on public.inventory_items(warehouse_id);
create index if not exists charges_warehouse_id_idx on public.charges(warehouse_id);

create or replace function public.current_user_role()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((select role from public.profiles where id = auth.uid()), 'warehouse')
$$;

create or replace function public.current_user_warehouse_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select warehouse_id from public.profiles where id = auth.uid()
$$;

create or replace function public.current_user_is_owner()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.current_user_role() in ('owner', 'admin')
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
        join public.warehouses w on w.id = p.warehouse_id
        where p.id = auth.uid()
          and (target_warehouse_name = w.name or target_warehouse_name = w.code)
      )
    )
$$;

create or replace function public.sync_activity_warehouse()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.warehouse_id is null and new.warehouse is not null then
    select id
    into new.warehouse_id
    from public.warehouses
    where name = new.warehouse or code = new.warehouse
    limit 1;
  end if;

  if new.warehouse_id is not null then
    select name
    into new.warehouse
    from public.warehouses
    where id = new.warehouse_id;
  end if;

  return new;
end;
$$;

drop trigger if exists sync_activity_warehouse_before_write on public.activities;
create trigger sync_activity_warehouse_before_write
before insert or update of warehouse_id, warehouse on public.activities
for each row
execute function public.sync_activity_warehouse();

alter table public.warehouses enable row level security;
alter table public.activities enable row level security;
alter table public.documents enable row level security;
alter table public.inventory_items enable row level security;
alter table public.charges enable row level security;

drop policy if exists "Owners can manage warehouses" on public.warehouses;
drop policy if exists "Users can read active warehouses" on public.warehouses;
drop policy if exists "Users can read assigned activities" on public.activities;
drop policy if exists "Users can insert assigned activities" on public.activities;
drop policy if exists "Users can update assigned activities" on public.activities;
drop policy if exists "Users can delete assigned activities" on public.activities;
drop policy if exists "Users can read assigned documents" on public.documents;
drop policy if exists "Users can manage assigned documents" on public.documents;
drop policy if exists "Users can read assigned inventory" on public.inventory_items;
drop policy if exists "Users can manage assigned inventory" on public.inventory_items;
drop policy if exists "Users can read assigned charges" on public.charges;
drop policy if exists "Owners can manage charges" on public.charges;

create policy "Owners can manage warehouses"
on public.warehouses
for all
to authenticated
using (public.current_user_is_owner())
with check (public.current_user_is_owner());

create policy "Users can read active warehouses"
on public.warehouses
for select
to authenticated
using (active = true or public.current_user_is_owner());

create policy "Users can read assigned activities"
on public.activities
for select
to authenticated
using (public.user_can_access_warehouse(warehouse_id, warehouse));

create policy "Users can insert assigned activities"
on public.activities
for insert
to authenticated
with check (public.user_can_access_warehouse(warehouse_id, warehouse));

create policy "Users can update assigned activities"
on public.activities
for update
to authenticated
using (public.user_can_access_warehouse(warehouse_id, warehouse))
with check (public.user_can_access_warehouse(warehouse_id, warehouse));

create policy "Users can delete assigned activities"
on public.activities
for delete
to authenticated
using (public.user_can_access_warehouse(warehouse_id, warehouse));

create policy "Users can read assigned documents"
on public.documents
for select
to authenticated
using (public.user_can_access_warehouse(warehouse_id));

create policy "Users can manage assigned documents"
on public.documents
for all
to authenticated
using (public.user_can_access_warehouse(warehouse_id))
with check (public.user_can_access_warehouse(warehouse_id));

create policy "Users can read assigned inventory"
on public.inventory_items
for select
to authenticated
using (public.user_can_access_warehouse(warehouse_id, warehouse));

create policy "Users can manage assigned inventory"
on public.inventory_items
for all
to authenticated
using (public.user_can_access_warehouse(warehouse_id, warehouse))
with check (public.user_can_access_warehouse(warehouse_id, warehouse));

create policy "Users can read assigned charges"
on public.charges
for select
to authenticated
using (public.user_can_access_warehouse(warehouse_id, warehouse));

create policy "Owners can manage charges"
on public.charges
for all
to authenticated
using (public.current_user_is_owner())
with check (public.current_user_is_owner());
