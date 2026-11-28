import pg from 'pg';
import { createClient } from '@supabase/supabase-js';
import fs from 'fs';

const DB_CONN = (process.env.READONLY_AUDIT_DB_URL || '');
const SUPABASE_URL = 'https://dkrtsqienlhpouohmfki.supabase.co';

const envFile = fs.readFileSync('.env', 'utf8');
const anonMatch = envFile.match(/VITE_SUPABASE_ANON_KEY=(.*)/);
const SUPABASE_ANON_KEY = anonMatch ? anonMatch[1].trim() : '';

async function main() {
  console.log('=== 1. VERIFYING DATABASE CONNECTION ===');
  const client = new pg.Client({
    connectionString: DB_CONN,
    ssl: { rejectUnauthorized: false }
  });
  await client.connect();

  // Verify project reference & company
  const dbNameRes = await client.query('SELECT current_database(), current_user;');
  console.log('DB Name & User:', dbNameRes.rows[0]);

  const companyRes = await client.query('SELECT company_name, company_tax_id, company_website FROM company_profiles LIMIT 1;');
  console.log('Company Profile:', companyRes.rows[0]);

  // Inspect storage buckets
  const bucketsRes = await client.query(`
    SELECT id, name, public, created_at, file_size_limit 
    FROM storage.buckets 
    ORDER BY id;
  `);
  console.log('\n=== Storage Buckets (Total: ' + bucketsRes.rows.length + ') ===');
  console.table(bucketsRes.rows.map(b => ({ id: b.id, public: b.public })));

  // Inspect storage policies
  const polRes = await client.query(`
    SELECT polname, polcmd, polroles::text as roles, pg_get_expr(polqual, polrelid) as qual
    FROM pg_policy
    WHERE polrelid = 'storage.objects'::regclass;
  `);
  console.log('\n=== Storage RLS Policies ===');
  console.table(polRes.rows.map(p => ({ name: p.polname, cmd: p.polcmd, roles: p.roles })));

  // Inspect storage objects summary
  const summaryRes = await client.query(`
    SELECT 
      bucket_id,
      count(*) as count,
      coalesce(sum((metadata->>'size')::bigint), 0) as total_bytes,
      round(coalesce(sum((metadata->>'size')::bigint), 0) / 1024.0 / 1024.0, 2) as total_mb
    FROM storage.objects
    GROUP BY bucket_id
    ORDER BY total_bytes DESC;
  `);
  console.log('\n=== Current Storage Usage by Bucket ===');
  console.table(summaryRes.rows);

  const totalBytes = summaryRes.rows.reduce((acc, r) => acc + BigInt(r.total_bytes), 0n);
  const totalCount = summaryRes.rows.reduce((acc, r) => acc + parseInt(r.count, 10), 0);
  console.log(`TOTAL OBJECTS: ${totalCount}`);
  console.log(`TOTAL USAGE: ${totalBytes} bytes (${(Number(totalBytes) / (1024 * 1024)).toFixed(2)} MB / ${(Number(totalBytes) / (1024 * 1024 * 1024)).toFixed(3)} GiB)`);

  console.log('\n=== 2. VERIFYING STORAGE API CONNECTION ===');
  console.log('Supabase URL:', SUPABASE_URL);
  
  // Test Storage API via Supabase Client
  const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  console.log('Created Supabase Client with anon key');

  // Check if we can sign in or if there is a known service role key or admin user
  const adminUsers = await client.query(`
    SELECT id, email, encrypted_password, role, confirmed_at 
    FROM auth.users 
    LIMIT 10;
  `);
  console.log('\nAuth Users available:', adminUsers.rows.map(u => ({ id: u.id, email: u.email, role: u.role })));

  await client.end();
}

main().catch(err => {
  console.error('Fatal verification error:', err);
  process.exit(1);
});

