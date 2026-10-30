-- =====================================================================================================
-- 11_storage_buckets.sql
-- Purpose : the five PRIVATE Supabase Storage buckets and the access policies on storage.objects.
--             lead-docs, site-photos, quote-pdfs, compliance-docs, invoices
-- Run after: 10_views.sql   (needs the app.* helper functions from 08 / 09)
-- Idempotent: buckets are inserted with `on conflict do nothing` and then re-asserted private; policies are dropped
--             then recreated.
--
-- Conventions
--   * Every bucket is private (public = false), 10 MB per file, images (jpeg / png / webp) and PDF only. The API enforces
--     the same limits, rejects Aadhaar-looking file names, and hands out short-lived signed URLs.
--   * Object paths MUST start with the organisation id:  <org_id>/<entity_type>/<entity_id>/<file>.
--     The policies below allow access only when the first folder equals the caller's organisation, so one tenant can never
--     read or write another tenant's objects through the Storage API.
--   * Read / write access is limited to INTERNAL roles. Distributors and dealers upload and download through the API (which
--     uses the service role and applies party scoping), never directly.
--   * The documents table (05) holds the metadata row for every object.
-- =====================================================================================================

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types) values
  ('lead-docs',       'lead-docs',       false, 10485760, array['image/jpeg', 'image/png', 'image/webp', 'application/pdf']),
  ('site-photos',     'site-photos',     false, 10485760, array['image/jpeg', 'image/png', 'image/webp', 'application/pdf']),
  ('quote-pdfs',      'quote-pdfs',      false, 10485760, array['image/jpeg', 'image/png', 'image/webp', 'application/pdf']),
  ('compliance-docs', 'compliance-docs', false, 10485760, array['image/jpeg', 'image/png', 'image/webp', 'application/pdf']),
  ('invoices',        'invoices',        false, 10485760, array['image/jpeg', 'image/png', 'image/webp', 'application/pdf'])
on conflict (id) do nothing;

-- Re-assert privacy and limits on buckets that already existed (never public).
update storage.buckets
   set public = false,
       file_size_limit = 10485760,
       allowed_mime_types = array['image/jpeg', 'image/png', 'image/webp', 'application/pdf']
 where id in ('lead-docs', 'site-photos', 'quote-pdfs', 'compliance-docs', 'invoices');

-- -----------------------------------------------------------------------------------------------------
-- Policies on storage.objects (authenticated users only; the service role bypasses them)
-- -----------------------------------------------------------------------------------------------------
drop policy if exists crm_objects_select on storage.objects;
create policy crm_objects_select on storage.objects for select to authenticated
  using (
    bucket_id in ('lead-docs', 'site-photos', 'quote-pdfs', 'compliance-docs', 'invoices')
    and (storage.foldername(name))[1] = (select app.current_org())::text
    and (select app.is_internal())
  );

drop policy if exists crm_objects_insert on storage.objects;
create policy crm_objects_insert on storage.objects for insert to authenticated
  with check (
    bucket_id in ('lead-docs', 'site-photos', 'quote-pdfs', 'compliance-docs', 'invoices')
    and (storage.foldername(name))[1] = (select app.current_org())::text
    and app.role_in('admin', 'management', 'regional_head', 'sales_manager', 'dsm', 'techno_commercial', 'accounts', 'compliance_officer', 'dispatch')
  );

drop policy if exists crm_objects_update on storage.objects;
create policy crm_objects_update on storage.objects for update to authenticated
  using (
    bucket_id in ('lead-docs', 'site-photos', 'quote-pdfs', 'compliance-docs', 'invoices')
    and (storage.foldername(name))[1] = (select app.current_org())::text
    and app.role_in('admin', 'management', 'regional_head', 'sales_manager', 'dsm', 'techno_commercial', 'accounts', 'compliance_officer', 'dispatch')
  )
  with check (
    bucket_id in ('lead-docs', 'site-photos', 'quote-pdfs', 'compliance-docs', 'invoices')
    and (storage.foldername(name))[1] = (select app.current_org())::text
  );

drop policy if exists crm_objects_delete on storage.objects;
create policy crm_objects_delete on storage.objects for delete to authenticated
  using (
    bucket_id in ('lead-docs', 'site-photos', 'quote-pdfs', 'compliance-docs', 'invoices')
    and (storage.foldername(name))[1] = (select app.current_org())::text
    and app.role_in('admin', 'management', 'compliance_officer')
  );
