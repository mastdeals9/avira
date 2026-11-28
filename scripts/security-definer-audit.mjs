import fs from 'fs';
import path from 'path';
import { Client } from 'pg';

const repoRoot = process.cwd();
const srcDirs = ['src', 'scripts', 'supabase/functions'];

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.(ts|tsx|js|jsx|sql|mjs|cjs)$/.test(entry.name)) out.push(full);
  }
  return out;
}

function extractRpcNames(text) {
  const names = new Set();
  const re = /\.rpc\(\s*['\"]([a-zA-Z0-9_]+)['\"]/g;
  let m;
  while ((m = re.exec(text))) names.add(m[1]);
  return names;
}

async function main() {
  const dbUrl = process.env.READONLY_AUDIT_DB_URL || process.env.READONLY_AUDIT_DB_URL || process.env.READONLY_AUDIT_DB_URL;
  if (!dbUrl) throw new Error('Missing SUPABASE_DB_URL (or DATABASE_URL/POSTGRES_URL).');

  const rpcNames = new Set();
  for (const d of srcDirs) {
    const abs = path.join(repoRoot, d);
    if (!fs.existsSync(abs)) continue;
    for (const file of walk(abs)) {
      const text = fs.readFileSync(file, 'utf8');
      extractRpcNames(text).forEach((n) => rpcNames.add(n));
    }
  }

  const client = new Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  await client.connect();

  const q = `
WITH secdef AS (
  SELECT p.oid,
         n.nspname AS schema_name,
         p.proname AS function_name,
         p.prosecdef,
         pg_get_function_identity_arguments(p.oid) AS identity_args,
         pg_get_functiondef(p.oid) AS function_def,
         has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_exec,
         has_function_privilege('public', p.oid, 'EXECUTE') AS public_exec,
         has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated_exec
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.prosecdef = true
), trg AS (
  SELECT tgfoid AS oid,
         count(*) FILTER (WHERE NOT tgisinternal) AS trigger_count,
         string_agg(DISTINCT tgname, ', ' ORDER BY tgname) FILTER (WHERE NOT tgisinternal) AS triggers
  FROM pg_trigger GROUP BY tgfoid
)
SELECT s.*, COALESCE(t.trigger_count,0) AS trigger_count, COALESCE(t.triggers,'') AS triggers
FROM secdef s
LEFT JOIN trg t USING (oid)
ORDER BY s.schema_name, s.function_name, s.identity_args;`;

  const res = await client.query(q);
  await client.end();

  const rows = res.rows.map((r) => {
    const def = (r.function_def || '').toLowerCase();
    const hasRoleCheck = /auth\.uid\(\)|user_profiles|\brole\b|is_admin|has_role|jwt/.test(def);
    const name = r.function_name;
    const isRpcUsed = rpcNames.has(name);

    let classification = 'obsolete/unused';
    let recommendation = 'revoke authenticated EXECUTE after confirmation';

    if (r.trigger_count > 0) {
      classification = 'trigger-only/internal';
      recommendation = 'safe to revoke authenticated EXECUTE';
    } else if (isRpcUsed) {
      classification = 'frontend RPC required';
      recommendation = 'keep authenticated EXECUTE; enforce least privilege and role checks';
    } else if (/report|summary|ledger|balance|trial|statement|get_/.test(name)) {
      classification = 'report/read-only';
      recommendation = 'consider SECURITY INVOKER + rely on RLS';
    } else if (/generate|next|sequence|number|increment/.test(name)) {
      classification = 'helper/number-generator';
      recommendation = 'confirm frontend need; otherwise revoke authenticated EXECUTE';
    }

    if (hasRoleCheck && classification !== 'frontend RPC required') {
      classification = 'admin-only';
      recommendation = 'validate role check and keep execute only where needed';
    }

    return {
      schema_name: r.schema_name,
      function_name: r.function_name,
      identity_args: r.identity_args,
      anon_exec: r.anon_exec,
      public_exec: r.public_exec,
      authenticated_exec: r.authenticated_exec,
      trigger_count: r.trigger_count,
      triggers: r.triggers,
      role_check_detected: hasRoleCheck,
      rpc_used_in_repo: isRpcUsed,
      classification,
      recommendation
    };
  });

  fs.mkdirSync(path.join(repoRoot, 'audit'), { recursive: true });
  const csvHeader = Object.keys(rows[0] || {}).join(',');
  const csvBody = rows.map((row) => Object.values(row).map((v) => {
    const s = String(v ?? '');
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }).join(',')).join('\n');
  fs.writeFileSync('audit/security_definer_audit.csv', `${csvHeader}\n${csvBody}\n`);

  const md = [
    '# SECURITY DEFINER Audit',
    '',
    `Generated: ${new Date().toISOString()}`,
    `Total SECURITY DEFINER in public: ${rows.length}`,
    '',
    '| function | args | anon | public | authenticated | triggers | rpc_used | role_check | classification | recommendation |',
    '|---|---|---:|---:|---:|---:|---:|---:|---|---|',
    ...rows.map((r) => `| ${r.function_name} | ${r.identity_args.replace(/\|/g,'/')} | ${r.anon_exec} | ${r.public_exec} | ${r.authenticated_exec} | ${r.trigger_count} | ${r.rpc_used_in_repo} | ${r.role_check_detected} | ${r.classification} | ${r.recommendation} |`)
  ].join('\n');
  fs.writeFileSync('audit/security_definer_audit.md', md + '\n');

  console.log(`Wrote audit/security_definer_audit.csv and .md (${rows.length} functions).`);
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
