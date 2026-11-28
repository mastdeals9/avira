// scripts/audit_storage_and_db.mjs
import pg from 'pg';
import fs from 'fs';

const { Client } = pg;
const client = new Client({
  connectionString: (process.env.READONLY_AUDIT_DB_URL || ''),
  ssl: { rejectUnauthorized: false }
});

async function runAudit() {
  await client.connect();
  console.log('--- STARTING COMPREHENSIVE SUPABASE STORAGE & DATABASE AUDIT ---');

  // 1. Storage Buckets & Objects
  console.log('\n=== 1. STORAGE BUCKETS AUDIT ===');
  const bucketsRes = await client.query(`
    SELECT 
      b.id,
      b.name,
      b.public,
      b.created_at,
      b.file_size_limit,
      b.allowed_mime_types
    FROM storage.buckets b
    ORDER BY b.id;
  `);

  const objectsSummaryRes = await client.query(`
    SELECT 
      bucket_id,
      COUNT(*) AS object_count,
      COALESCE(SUM((metadata->>'size')::bigint), 0) AS total_bytes,
      COALESCE(AVG((metadata->>'size')::bigint), 0) AS avg_bytes,
      MIN(created_at) AS oldest_created,
      MAX(created_at) AS newest_created
    FROM storage.objects
    GROUP BY bucket_id
    ORDER BY total_bytes DESC;
  `);

  console.log('Buckets List:', bucketsRes.rows);
  console.log('Objects per Bucket Summary:', objectsSummaryRes.rows);

  // Top 20 largest files in storage
  const topFilesRes = await client.query(`
    SELECT 
      id,
      bucket_id,
      name,
      (metadata->>'size')::bigint AS size_bytes,
      metadata->>'mimetype' AS mime_type,
      created_at
    FROM storage.objects
    ORDER BY (metadata->>'size')::bigint DESC NULLS LAST
    LIMIT 20;
  `);
  console.log('\nTop 20 Largest Files across Storage:', topFilesRes.rows);

  // Storage files by MIME type
  const mimeTypeRes = await client.query(`
    SELECT 
      bucket_id,
      COALESCE(metadata->>'mimetype', 'unknown') AS mime_type,
      COUNT(*) AS count,
      SUM((metadata->>'size')::bigint) AS total_bytes
    FROM storage.objects
    GROUP BY bucket_id, metadata->>'mimetype'
    ORDER BY bucket_id, total_bytes DESC;
  `);
  console.log('\nStorage by MIME type:', mimeTypeRes.rows);

  // 2. Database Table Sizes (Top 35 tables)
  console.log('\n=== 2. DATABASE TABLE SIZES AUDIT ===');
  const tableSizesRes = await client.query(`
    SELECT 
      c.relname AS table_name,
      pg_stat_get_live_tuples(c.oid) AS approx_row_count,
      pg_total_relation_size(c.oid) AS total_bytes,
      pg_relation_size(c.oid) AS table_bytes,
      pg_indexes_size(c.oid) AS index_bytes,
      pg_total_relation_size(c.oid) - pg_relation_size(c.oid) - pg_indexes_size(c.oid) AS toast_bytes,
      pg_size_pretty(pg_total_relation_size(c.oid)) AS total_size_pretty,
      pg_size_pretty(pg_relation_size(c.oid)) AS table_size_pretty,
      pg_size_pretty(pg_indexes_size(c.oid)) AS index_size_pretty,
      pg_size_pretty(pg_total_relation_size(c.oid) - pg_relation_size(c.oid) - pg_indexes_size(c.oid)) AS toast_size_pretty
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' 
      AND c.relkind = 'r'
    ORDER BY pg_total_relation_size(c.oid) DESC
    LIMIT 35;
  `);
  console.log('Top 35 Tables by Total Size:');
  console.table(tableSizesRes.rows.map(r => ({
    table: r.table_name,
    rows: r.approx_row_count,
    total: r.total_size_pretty,
    table_bytes: r.table_size_pretty,
    indexes: r.index_size_pretty,
    toast: r.toast_size_pretty
  })));

  // Database Overall Size
  const dbSizeRes = await client.query(`
    SELECT 
      pg_database_size(current_database()) AS db_bytes,
      pg_size_pretty(pg_database_size(current_database())) AS db_size_pretty;
  `);
  console.log('\nTotal Database Size:', dbSizeRes.rows[0]);

  // 3. Scan for Synthetic / Test Data in CRM & Messaging
  console.log('\n=== 3. SYNTHETIC / TEST DATA SCAN ===');
  
  // CRM Contacts: search for test/dummy patterns
  const testContactsRes = await client.query(`
    SELECT id, company_name, contact_person, email, phone, is_active, created_at
    FROM public.crm_contacts
    WHERE company_name ILIKE '%test%' 
       OR company_name ILIKE '%farmindo mitra%'
       OR contact_person ILIKE '%representative %'
       OR email ILIKE '%test%'
       OR email ILIKE '%dummy%'
    ORDER BY created_at DESC;
  `);
  console.log(`Potential Test CRM Contacts count: ${testContactsRes.rows.length}`);
  if (testContactsRes.rows.length > 0) {
    console.log('Sample test contacts:', testContactsRes.rows.slice(0, 10));
  }

  // Tasks: search for test/dummy patterns
  const testTasksRes = await client.query(`
    SELECT id, title, description, deadline, status, created_at
    FROM public.tasks
    WHERE title ILIKE '%test%'
       OR title ILIKE '%dummy%'
       OR title ILIKE '%playwright%'
       OR description ILIKE '%test auto analysis%'
    ORDER BY created_at DESC;
  `);
  console.log(`Potential Test Tasks count: ${testTasksRes.rows.length}`);
  if (testTasksRes.rows.length > 0) {
    console.log('Sample test tasks:', testTasksRes.rows.slice(0, 5));
  }

  // Activities: search for test activities
  const testActivitiesRes = await client.query(`
    SELECT id, activity_type, subject, description, created_at
    FROM public.crm_activities
    WHERE subject ILIKE '%test%'
       OR description ILIKE '%test%'
    ORDER BY created_at DESC;
  `);
  console.log(`Potential Test CRM Activities count: ${testActivitiesRes.rows.length}`);
  if (testActivitiesRes.rows.length > 0) {
    console.log('Sample test activities:', testActivitiesRes.rows.slice(0, 5));
  }

  // Inquiries: search for test inquiries
  const testInquiriesRes = await client.query(`
    SELECT id, inquiry_number, company_name, product_name, status, created_at
    FROM public.crm_inquiries
    WHERE company_name ILIKE '%test%'
       OR product_name ILIKE '%test%'
       OR inquiry_number ILIKE '%test%'
    ORDER BY created_at DESC;
  `);
  console.log(`Potential Test CRM Inquiries count: ${testInquiriesRes.rows.length}`);
  if (testInquiriesRes.rows.length > 0) {
    console.log('Sample test inquiries:', testInquiriesRes.rows.slice(0, 5));
  }

  // Conversations: search for test conversations
  const testConvsRes = await client.query(`
    SELECT id, channel, title, last_message_at
    FROM public.enquiry_conversations
    WHERE title ILIKE '%test%'
       OR title ILIKE '%diagnostic%'
    ORDER BY last_message_at DESC;
  `);
  console.log(`Potential Test Conversations count: ${testConvsRes.rows.length}`);

  // Save audit data to JSON for reporting
  const auditReport = {
    timestamp: new Date().toISOString(),
    db_size: dbSizeRes.rows[0],
    buckets: bucketsRes.rows,
    objects_summary: objectsSummaryRes.rows,
    top_files: topFilesRes.rows,
    mime_types: mimeTypeRes.rows,
    top_tables: tableSizesRes.rows,
    potential_test_records: {
      contacts_count: testContactsRes.rows.length,
      tasks_count: testTasksRes.rows.length,
      activities_count: testActivitiesRes.rows.length,
      inquiries_count: testInquiriesRes.rows.length,
      conversations_count: testConvsRes.rows.length,
    }
  };

  fs.writeFileSync('scripts/audit_output.json', JSON.stringify(auditReport, null, 2));
  console.log('\nAudit data saved to scripts/audit_output.json');

  await client.end();
}

runAudit().catch(err => {
  console.error('Audit failed:', err);
  process.exit(1);
});

