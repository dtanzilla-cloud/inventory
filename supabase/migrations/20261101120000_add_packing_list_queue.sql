-- Packing lists found by the scan-packing-lists function, waiting for an owner to review.
create table if not exists public.packing_list_queue (
  id bigint generated always as identity primary key,
  drive_file_id text not null unique,
  file_name text not null,
  file_path text not null default '',
  web_view_link text not null default '',
  md5 text not null default '',
  drive_modified_at timestamptz,
  status text not null default 'pending'
    check (status in ('baseline', 'duplicate', 'pending', 'added', 'dismissed')),
  reasons text[] not null default '{}',
  draft jsonb,
  activity_ids bigint[] not null default '{}',
  reviewed_by uuid references auth.users(id),
  reviewed_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists packing_list_queue_pending_idx
  on public.packing_list_queue(created_at) where status = 'pending';

alter table public.packing_list_queue enable row level security;

-- The function uses the service role, which skips these policies. Nobody else can insert.
drop policy if exists "packing_list_queue_select_owner" on public.packing_list_queue;
create policy "packing_list_queue_select_owner"
on public.packing_list_queue
for select
to authenticated
using (exists (
  select 1 from public.profiles
  where profiles.id = auth.uid() and profiles.role in ('owner', 'admin') and profiles.active
));

drop policy if exists "packing_list_queue_update_owner" on public.packing_list_queue;
create policy "packing_list_queue_update_owner"
on public.packing_list_queue
for update
to authenticated
using (exists (
  select 1 from public.profiles
  where profiles.id = auth.uid() and profiles.role in ('owner', 'admin') and profiles.active
))
with check (exists (
  select 1 from public.profiles
  where profiles.id = auth.uid() and profiles.role in ('owner', 'admin') and profiles.active
));

-- Adds the reviewed rows and closes the entry together, so a double click or a second owner
-- cannot add the same packing list twice.
create or replace function public.approve_packing_list(entry_id bigint, draft_rows jsonb)
returns setof public.activities
language plpgsql
security invoker
set search_path = public
as $$
declare
  added_ids bigint[];
begin
  perform 1
  from public.packing_list_queue
  where id = entry_id and status = 'pending'
  for update;

  if not found then
    raise exception 'This packing list was already handled.';
  end if;

  if jsonb_typeof(draft_rows) <> 'array' or jsonb_array_length(draft_rows) = 0 then
    raise exception 'There are no rows to add.';
  end if;

  with inserted as (
    insert into public.activities
      (activity_date, warehouse, warehouse_id, pallets, pieces, product, customer, lot_number, expiration_date, supplier, repack, note)
    select
      activity_date, warehouse, warehouse_id, pallets, pieces, product, customer, lot_number, expiration_date, supplier, repack, note
    from jsonb_populate_recordset(null::public.activities, draft_rows)
    returning id
  )
  select array_agg(id::bigint) into added_ids from inserted;

  update public.packing_list_queue
  set status = 'added', activity_ids = added_ids, reviewed_by = auth.uid(), reviewed_at = now()
  where id = entry_id;

  return query select * from public.activities where id::bigint = any(added_ids);
end;
$$;

revoke all on function public.approve_packing_list(bigint, jsonb) from public, anon;
grant execute on function public.approve_packing_list(bigint, jsonb) to authenticated;
