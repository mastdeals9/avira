-- ==============================================================================
-- PT SHUBHAM ANZEN PHARMA JAYA (SAPJ) — UNIVERSAL DOCUMENT BANK
-- CORRECTED REVISED PROPOSAL (PROPOSAL DB-01) — STRICT PRIVATE STORAGE INTEGRITY
-- ==============================================================================
-- Target Table: public.universal_document_versions
-- Architectural Principles:
--   1. Storage buckets ('crm-documents', 'product-documents', 'batch-documents',
--      'product-source-documents') are STRICTLY PRIVATE under Storage RLS.
--   2. Permanent storage pointers are 'storage_bucket' and 'storage_path'.
--   3. NO public URLs ('/storage/v1/object/public/') must ever be stored or generated.
--   4. Short-lived signed URLs are generated on-demand at runtime via createSignedUrl.
--   5. Version flags ('is_current', 'version_number') are preserved untouched.
--   6. SHA-256 hashes must be computed exclusively from physical file binaries.
--
-- Safety Classification: PROPOSAL ONLY — Non-destructive, idempotent.
-- ==============================================================================

-- STEP 1: Non-Destructive Inspection of Universal Document Bank Versions
-- Identifies versions where binary SHA-256 has not yet been computed
SELECT 
    v.id,
    v.document_id,
    v.version_number,
    v.storage_bucket,
    v.storage_path,
    v.original_file_name,
    v.file_size,
    v.is_current,
    v.sha256,
    v.created_at
FROM public.universal_document_versions v
WHERE v.sha256 IS NULL
ORDER BY v.storage_bucket, v.created_at ASC;

-- STEP 2: Summary of Private Storage Objects Needing Verification & Hashing
SELECT 
    storage_bucket,
    COUNT(*) as total_versions,
    COUNT(*) FILTER (WHERE sha256 IS NOT NULL) as hashed_versions,
    COUNT(*) FILTER (WHERE sha256 IS NULL) as unhashed_versions,
    COUNT(*) FILTER (WHERE storage_path IS NULL OR trim(storage_path) = '') as missing_storage_path
FROM public.universal_document_versions
GROUP BY storage_bucket;

-- STEP 3: Clarification Regarding file_url
-- In the ANZEN ERP architecture, resolveDocumentViewUrl() uses storage_bucket and
-- storage_path to obtain a short-lived authenticated signed URL (1 hour validity)
-- via Supabase Storage createSignedUrl.
-- Permanent public file_urls are intentionally NOT used for private compliance documents
-- (COAs, GMP certificates, MSDS, batch records, financial attachments).
-- Any historical public file_url values remain deprecated in favor of (storage_bucket, storage_path).

-- STEP 4: SQL Pattern for Applying Verified SHA-256 Binary Checksums
-- Applied strictly after offline script downloads and computes cryptographic hash:
--
-- UPDATE public.universal_document_versions
-- SET sha256 = $1,
--     updated_at = NOW()
-- WHERE id = $2
--   AND sha256 IS NULL
--   AND storage_bucket = $3
--   AND storage_path = $4;
