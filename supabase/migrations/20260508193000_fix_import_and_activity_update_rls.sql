create or replace function public.current_user_role()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((select role from public.profiles where id = auth.uid()), 'warehouse')
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

create or replace function public.current_user_warehouse_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select warehouse_id from public.profiles where id = auth.uid()
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
          and (target_warehouse_name = p.warehouse or target_warehouse_name = w.name or target_warehouse_name = w.code)
      )
    )
$$;

alter table public.activities enable row level security;
alter table public.products enable row level security;
alter table public.customers enable row level security;
alter table public.suppliers enable row level security;

drop policy if exists "activities_update_scoped" on public.activities;
drop policy if exists "Users can update assigned activities" on public.activities;

create policy "activities_update_scoped"
on public.activities
for update
to authenticated
using (public.user_can_access_warehouse(warehouse_id, warehouse))
with check (public.user_can_access_warehouse(warehouse_id, warehouse));

drop policy if exists "products_insert_owner" on public.products;
drop policy if exists "products_update_owner" on public.products;
drop policy if exists "customers_insert_owner" on public.customers;
drop policy if exists "customers_update_owner" on public.customers;
drop policy if exists "suppliers_insert_owner" on public.suppliers;
drop policy if exists "suppliers_update_owner" on public.suppliers;

create policy "products_insert_owner"
on public.products for insert
to authenticated
with check (public.current_user_is_owner());

create policy "products_update_owner"
on public.products for update
to authenticated
using (public.current_user_is_owner())
with check (public.current_user_is_owner());

create policy "customers_insert_owner"
on public.customers for insert
to authenticated
with check (public.current_user_is_owner());

create policy "customers_update_owner"
on public.customers for update
to authenticated
using (public.current_user_is_owner())
with check (public.current_user_is_owner());

create policy "suppliers_insert_owner"
on public.suppliers for insert
to authenticated
with check (public.current_user_is_owner());

create policy "suppliers_update_owner"
on public.suppliers for update
to authenticated
using (public.current_user_is_owner())
with check (public.current_user_is_owner());
