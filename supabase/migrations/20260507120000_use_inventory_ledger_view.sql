grant select on public.inventory_ledger to authenticated;

-- inventory_ledger should be created as a security_invoker view over RLS-protected inventory/activity tables.
-- Owner users can see every warehouse through the underlying policies; warehouse users only see their warehouse.
