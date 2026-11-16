import pg from 'pg';
import fs from 'fs';

const connectionString = 'postgresql://postgres.dkrtsqienlhpouohmfki:Kunallunkad%40123@aws-1-ap-southeast-1.pooler.supabase.com:6543/postgres';

async function auditSecurityCatalog() {
  const client = new pg.Client({ connectionString });
  await client.connect();
  await client.query('BEGIN READ ONLY;');

  console.log('Connected to Supabase production database in READ-ONLY mode.');

  // 1. Check pg_net extension
  const extRes = await client.query(`
    SELECT e.extname, n.nspname as extnamespace, e.extversion
    FROM pg_extension e
    JOIN pg_namespace n ON n.oid = e.extnamespace
    WHERE e.extname = 'pg_net';
  `);
  console.log('pg_net extension:', extRes.rows);

  // Check objects created by pg_net
  const netObjectsRes = await client.query(`
    SELECT n.nspname, c.relname, c.relkind
    FROM pg_depend d
    JOIN pg_extension e ON d.refobjid = e.oid
    JOIN pg_class c ON d.objid = c.oid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE e.extname = 'pg_net'
    UNION
    SELECT n.nspname, p.proname, 'f' as relkind
    FROM pg_depend d
    JOIN pg_extension e ON d.refobjid = e.oid
    JOIN pg_proc p ON d.objid = p.oid
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE e.extname = 'pg_net';
  `);
  console.log('pg_net objects count:', netObjectsRes.rows.length);

  // 2. Check public.vw_universal_document_bank definition and options
  const viewRes = await client.query(`
    SELECT 
      c.relname,
      n.nspname,
      c.relkind,
      c.reloptions,
      pg_get_viewdef(c.oid, true) as definition
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'vw_universal_document_bank';
  `);
  console.log('vw_universal_document_bank exists:', viewRes.rows.length > 0);
  if (viewRes.rows.length > 0) {
    console.log('reloptions:', viewRes.rows[0].reloptions);
  }

  // Check underlying tables of vw_universal_document_bank
  const viewTablesRes = await client.query(`
    SELECT 
      c.relname,
      c.relrowsecurity,
      c.relforcerowsecurity
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname IN ('universal_documents', 'universal_document_versions', 'companies');
  `);
  console.log('Underlying tables RLS:', viewTablesRes.rows);

  // 3. Supabase Security Advisor Linter: Mutable search_path
  // In Supabase linter:
  // SELECT p.proname, pg_get_function_identity_arguments(p.oid) as args, n.nspname, p.prosecdef, p.proconfig
  // FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  // WHERE p.prosecdef = true AND (p.proconfig IS NULL OR NOT array_to_string(p.proconfig, '') LIKE '%search_path=%')
  const mutableSearchPathRes = await client.query(`
    SELECT 
      p.oid,
      n.nspname as schema_name,
      p.proname as function_name,
      pg_get_function_identity_arguments(p.oid) as arguments,
      pg_get_function_result(p.oid) as result_type,
      p.prosecdef as security_definer,
      p.proconfig,
      pg_get_functiondef(p.oid) as function_def
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.prosecdef = true
      AND (
        p.proconfig IS NULL 
        OR NOT (array_to_string(p.proconfig, ' ') LIKE '%search_path=%')
      )
    ORDER BY p.proname;
  `);
  console.log(`\n=== MUTABLE SEARCH_PATH WARNINGS (${mutableSearchPathRes.rows.length}) ===`);
  mutableSearchPathRes.rows.forEach((r, idx) => {
    console.log(`${idx + 1}. ${r.schema_name}.${r.function_name}(${r.arguments}) -> config: ${JSON.stringify(r.proconfig)}`);
  });

  // 4. All SECURITY DEFINER functions in public
  const secDefRes = await client.query(`
    SELECT 
      p.oid,
      n.nspname as schema_name,
      p.proname as function_name,
      pg_get_function_identity_arguments(p.oid) as arguments,
      pg_get_function_result(p.oid) as result_type,
      p.prosecdef as security_definer,
      p.provolatile,
      p.proconfig,
      p.proowner::regrole::text as owner,
      has_function_privilege('anon', p.oid, 'EXECUTE') as anon_execute,
      has_function_privilege('authenticated', p.oid, 'EXECUTE') as authenticated_execute,
      has_function_privilege('service_role', p.oid, 'EXECUTE') as service_role_execute,
      has_function_privilege('public', p.oid, 'EXECUTE') as public_execute
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.prosecdef = true
    ORDER BY p.proname, p.oid;
  `);
  console.log(`\nTotal SECURITY DEFINER functions in public: ${secDefRes.rows.length}`);

  // Count anon-executable
  const anonSecDef = secDefRes.rows.filter(r => r.anon_execute);
  console.log(`SECURITY DEFINER functions executable by anon: ${anonSecDef.length}`);

  // Count authenticated-executable
  const authSecDef = secDefRes.rows.filter(r => r.authenticated_execute);
  console.log(`SECURITY DEFINER functions executable by authenticated: ${authSecDef.length}`);

  // 5. Check ALL functions executable by anon in public (including non-secdef)
  const allAnonRes = await client.query(`
    SELECT 
      p.oid,
      n.nspname as schema_name,
      p.proname as function_name,
      pg_get_function_identity_arguments(p.oid) as arguments,
      pg_get_function_result(p.oid) as result_type,
      p.prosecdef as security_definer,
      p.proowner::regrole::text as owner,
      has_function_privilege('anon', p.oid, 'EXECUTE') as anon_execute
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND has_function_privilege('anon', p.oid, 'EXECUTE')
    ORDER BY p.proname;
  `);
  console.log(`\nALL functions in public executable by anon: ${allAnonRes.rows.length}`);

  // 6. Check ALL functions executable by authenticated in public
  const allAuthRes = await client.query(`
    SELECT 
      p.oid,
      n.nspname as schema_name,
      p.proname as function_name,
      pg_get_function_identity_arguments(p.oid) as arguments,
      pg_get_function_result(p.oid) as result_type,
      p.prosecdef as security_definer,
      p.proowner::regrole::text as owner,
      has_function_privilege('authenticated', p.oid, 'EXECUTE') as auth_execute
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND has_function_privilege('authenticated', p.oid, 'EXECUTE')
    ORDER BY p.proname;
  `);
  console.log(`ALL functions in public executable by authenticated: ${allAuthRes.rows.length}`);

  // Write full catalog extraction to json for detailed analysis
  fs.writeFileSync('scripts/audits/catalog_secdef_functions.json', JSON.stringify(secDefRes.rows, null, 2));
  fs.writeFileSync('scripts/audits/catalog_mutable_search_path.json', JSON.stringify(mutableSearchPathRes.rows, null, 2));
  fs.writeFileSync('scripts/audits/catalog_anon_functions.json', JSON.stringify(allAnonRes.rows, null, 2));
  fs.writeFileSync('scripts/audits/catalog_auth_functions.json', JSON.stringify(allAuthRes.rows, null, 2));

  // Inspect lookup_login_email and invoke_process_whatsapp_campaign specifically
  const targetFuncs = await client.query(`
    SELECT 
      p.oid,
      n.nspname as schema_name,
      p.proname as function_name,
      pg_get_function_identity_arguments(p.oid) as arguments,
      pg_get_function_result(p.oid) as result_type,
      p.prosecdef,
      p.proconfig,
      has_function_privilege('anon', p.oid, 'EXECUTE') as anon_execute,
      has_function_privilege('authenticated', p.oid, 'EXECUTE') as auth_execute,
      pg_get_functiondef(p.oid) as function_def
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname IN ('lookup_login_email', 'invoke_process_whatsapp_campaign');
  `);
  console.log('\nTarget functions:', targetFuncs.rows.map(r => ({
    name: r.function_name,
    args: r.arguments,
    secdef: r.prosecdef,
    anon: r.anon_execute,
    auth: r.auth_execute
  })));
  fs.writeFileSync('scripts/audits/target_funcs_inspection.json', JSON.stringify(targetFuncs.rows, null, 2));

  await client.query('ROLLBACK;');
  await client.end();
  console.log('\nAudit catalog query completed successfully.');
}

auditSecurityCatalog().catch(err => {
  console.error('Audit failed:', err);
  process.exit(1);
});
