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
set name = excluded.name;

alter table if exists public.profiles
  add column if not exists warehouse text,
  add column if not exists warehouse_id uuid references public.warehouses(id);

alter table if exists public.activities
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

create index if not exists activities_warehouse_id_idx on public.activities(warehouse_id);
create index if not exists profiles_warehouse_id_idx on public.profiles(warehouse_id);

create or replace function public.current_user_is_owner()
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
      and role in ('owner', 'admin')
  )
$$;

alter table public.warehouses enable row level security;

drop policy if exists "Owners can manage warehouses" on public.warehouses;
drop policy if exists "Users can read active warehouses" on public.warehouses;
drop policy if exists "warehouses_select_active" on public.warehouses;
drop policy if exists "warehouses_insert_owner" on public.warehouses;
drop policy if exists "warehouses_update_owner" on public.warehouses;
drop policy if exists "warehouses_delete_owner" on public.warehouses;

create policy "warehouses_select_active"
on public.warehouses
for select
to authenticated
using (active = true or public.current_user_is_owner());

create policy "warehouses_insert_owner"
on public.warehouses
for insert
to authenticated
with check (public.current_user_is_owner());

create policy "warehouses_update_owner"
on public.warehouses
for update
to authenticated
using (public.current_user_is_owner())
with check (public.current_user_is_owner());

create policy "warehouses_delete_owner"
on public.warehouses
for delete
to authenticated
using (public.current_user_is_owner());
