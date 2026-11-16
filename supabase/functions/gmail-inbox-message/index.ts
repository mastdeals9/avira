import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { getGmailConnectionSecret, listGmailConnectionSecrets, type GmailConnectionSecret } from "../_shared/gmailSecrets.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey, X-Agent-Secret",
};

interface GmailConnection {
  id: string;
  user_id: string;
  email_address: string;
  access_token: string;
  refresh_token: string;
  access_token_expires_at: string | null;
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

async function getAuthUser(req: Request, supabaseUrl: string, anonKey: string) {
  const authHeader = req.headers.get("Authorization") || "";
  const jwt = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
  if (!jwt) return null;
  try {
    const userClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: `Bearer ${jwt}` } },
    });
    const { data, error } = await userClient.auth.getUser();
    if (error || !data?.user) return null;
    return data.user;
  } catch {
    return null;
  }
}

async function getConnection(supabase: any, userId: string): Promise<GmailConnection | null> {
  return await getGmailConnectionSecret(supabase, { userId }) as GmailConnection | null;
}

async function getValidAccessToken(supabase: any, connection: GmailConnection): Promise<string> {
  const expiry = new Date(connection.access_token_expires_at || 0);
  if (!Number.isNaN(expiry.getTime()) && expiry.getTime() - 5 * 60 * 1000 > Date.now()) {
    return connection.access_token;
  }
  const clientId = Deno.env.get("GOOGLE_CLIENT_ID") || Deno.env.get("GMAIL_CLIENT_ID") || "";
  const clientSecret = Deno.env.get("GOOGLE_CLIENT_SECRET") || Deno.env.get("GMAIL_CLIENT_SECRET") || "";
  if (!clientId || !clientSecret) throw new Error("MISSING_GOOGLE_OAUTH_CONFIG");

  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: connection.refresh_token,
      grant_type: "refresh_token",
    }),
  });
  if (!response.ok) throw new Error("TOKEN_REFRESH_FAILED");
  const data = await response.json();
  await supabase
    .from("gmail_connections")
    .update({
      access_token: data.access_token,
      access_token_expires_at: new Date(Date.now() + data.expires_in * 1000).toISOString(),
    })
    .eq("id", connection.id);
  return data.access_token;
}

function decodeBase64Url(data = ""): string {
  try {
    const normalized = data.replace(/-/g, "+").replace(/_/g, "/");
    const binary = atob(normalized);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return new TextDecoder("utf-8").decode(bytes);
  } catch {
    return "";
  }
}

function stripHtml(input: string): string {
  return input
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Server-side HTML sanitizer for safe rich-view rendering.
function sanitizeHtml(input: string): string {
  if (!input) return "";
  let html = input;
  const dangerousTags = ["script", "style", "iframe", "object", "embed", "link", "meta", "form", "input", "button", "textarea", "select", "base"];
  for (const tag of dangerousTags) {
    html = html.replace(new RegExp(`<${tag}[\\s\\S]*?<\\/${tag}>`, "gi"), " ");
    html = html.replace(new RegExp(`<${tag}[^>]*\\/?>`, "gi"), " ");
  }
  html = html.replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "");
  html = html.replace(/\s(href|src|action|formaction)\s*=\s*(["'])\s*(javascript|vbscript|file|data(?!:image\/))[^"']*\2/gi, ' $1="#"');
  html = html.replace(/\sstyle\s*=\s*("[^"]*expression\([^"]*"|'[^']*expression\([^']*'|"[^"]*javascript:[^"]*"|'[^']*javascript:[^']*')/gi, "");
  return html.slice(0, 200000);
}

function getHeader(headers: Array<{ name: string; value: string }> = [], name: string): string {
  return headers.find(h => h.name.toLowerCase() === name.toLowerCase())?.value || "";
}

function extractPayload(payload: any) {
  let text = "";
  let html = "";
  const attachments: Array<{ filename: string; mimeType: string; size: number; attachmentId: string }> = [];

  const visit = (part: any) => {
    if (!part) return;
    if (part.filename && part.body?.attachmentId) {
      attachments.push({
        filename: String(part.filename),
        mimeType: String(part.mimeType || "application/octet-stream"),
        size: Number(part.body?.size || 0),
        attachmentId: String(part.body.attachmentId),
      });
    }
    if (part.body?.data) {
      const decoded = decodeBase64Url(part.body.data);
      if (part.mimeType === "text/html") html ||= decoded;
      if (part.mimeType === "text/plain") text ||= decoded;
    }
    for (const child of part.parts || []) visit(child);
  };

  visit(payload);
  const sanitizedText = (text || stripHtml(html)).slice(0, 50000);
  const sanitizedHtml = html ? sanitizeHtml(html) : "";
  const plainText = text ? text.slice(0, 50000) : "";
  return { body: sanitizedText, bodyHtml: sanitizedHtml, bodyText: plainText, attachments };
}

function safeMessage(message: any, matchedInquiryId: string | null) {
  const headers = message?.payload?.headers || [];
  const extracted = extractPayload(message?.payload);
  return {
    messageId: message?.id,
    threadId: message?.threadId,
    from: getHeader(headers, "from"),
    to: getHeader(headers, "to"),
    cc: getHeader(headers, "cc"),
    subject: getHeader(headers, "subject") || "(No Subject)",
    date: getHeader(headers, "date") || (message?.internalDate ? new Date(Number(message.internalDate)).toISOString() : null),
    snippet: message?.snippet || "",
    body: extracted.body,
    bodyHtml: extracted.bodyHtml,
    bodyText: extracted.bodyText,
    attachments: extracted.attachments,
    hasAttachments: extracted.attachments.length > 0,
    labels: message?.labelIds || [],
    matchedInquiryId,
  };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const agentSecretHeader = req.headers.get("X-Agent-Secret") || req.headers.get("x-agent-secret") || "";
    const authHeader = req.headers.get("Authorization") || req.headers.get("authorization") || "";
    const apiKey = req.headers.get("Apikey") || req.headers.get("apikey") || "";
    const jwt = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : authHeader.trim();

    let isAuthorized = false;
    let callingUserId: string | null = null;

    const expectedAgentSecret = Deno.env.get("AGENT_SECRET") || Deno.env.get("CRON_SECRET");
    const isServiceCall = (jwt && jwt === serviceKey) || (apiKey && apiKey === serviceKey);
    const isCronCall = !!expectedAgentSecret && agentSecretHeader === expectedAgentSecret;

    if (isServiceCall || isCronCall) {
      isAuthorized = true;
    } else if (jwt) {
      const userClient = createClient(supabaseUrl, anonKey, {
        global: { headers: { Authorization: `Bearer ${jwt}` } },
      });
      const { data: userData, error: userErr } = await userClient.auth.getUser();
      if (!userErr && userData?.user) {
        callingUserId = userData.user.id;
        isAuthorized = true;
      }
    }

    if (!isAuthorized) {
      return json({ success: false, code: "MISSING_AUTH" }, 401);
    }
    const user = callingUserId ? { id: callingUserId } : null;
    const supabase = createClient(supabaseUrl, serviceKey);

    const url = new URL(req.url);
    const body = req.method === "POST" ? await req.json().catch(() => ({})) : {};
    let messageId = String(body.messageId || url.searchParams.get("messageId") || "");
    let threadId = String(body.threadId || url.searchParams.get("threadId") || "");
    const conversationId = String(body.conversationId || url.searchParams.get("conversationId") || "");
    const inquiryId = String(body.inquiryId || url.searchParams.get("inquiryId") || "");
    const includeThread = body.includeThread === true || url.searchParams.get("includeThread") === "true";
    const explicitConnectionId = String(body.connectionId || url.searchParams.get("connectionId") || "");

    if (!messageId && !threadId && conversationId) {
      const { data: convMsg } = await supabase
        .from("enquiry_conversation_messages")
        .select("external_message_id, metadata")
        .eq("conversation_id", conversationId)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (convMsg?.external_message_id) {
        messageId = convMsg.external_message_id;
      }
      if (convMsg?.metadata && typeof convMsg.metadata === "object") {
        const meta = convMsg.metadata as Record<string, unknown>;
        if (typeof meta.gmail_thread_id === "string") threadId = meta.gmail_thread_id;
        if (!messageId && typeof meta.gmail_message_id === "string") messageId = meta.gmail_message_id;
      }
    }

    if (!messageId && !threadId && inquiryId) {
      const { data: mapRow } = await supabase
        .from("email_thread_map")
        .select("gmail_message_id, gmail_thread_id")
        .eq("enquiry_id", inquiryId)
        .order("sent_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (mapRow) {
        if (mapRow.gmail_message_id) messageId = mapRow.gmail_message_id;
        if (mapRow.gmail_thread_id) threadId = mapRow.gmail_thread_id;
      }
    }

    if (!messageId && !threadId && !conversationId) {
      return json({ success: false, code: "MISSING_MESSAGE_ID", error: "Missing messageId or threadId" }, 400);
    }

    let targetAccountEmail = String(
      body.emailAddress ||
      (body.account === "crm" || body.mailbox === "crm" ? "sales@avira.co.id" : body.account === "pricing" || body.mailbox === "pricing" ? "kunal@avira.co.id" : "")
    ).toLowerCase().trim();

    // Map legacy sales@sapharmajaya.co.id to sales@avira.co.id
    if (targetAccountEmail === "sales@sapharmajaya.co.id") {
      targetAccountEmail = "sales@avira.co.id";
    }

    // 1. Gather candidate Gmail connections
    const candidateConnections: GmailConnectionSecret[] = [];
    let canAccessAllMailboxes = isServiceCall || isCronCall;
    if (user?.id) {
      const { data: profile } = await supabase
        .from("user_profiles")
        .select("role, is_active")
        .eq("id", user.id)
        .maybeSingle();
      if (profile?.is_active && (profile?.role === "admin" || profile?.role === "manager")) {
        canAccessAllMailboxes = true;
      }
    }

    if (explicitConnectionId) {
      const explicitConn = await getGmailConnectionSecret(supabase, { connectionId: explicitConnectionId });
      if (explicitConn && explicitConn.is_connected) {
        if (canAccessAllMailboxes || explicitConn.user_id === user?.id) {
          candidateConnections.push(explicitConn);
        }
      }
    }
    if (targetAccountEmail && canAccessAllMailboxes) {
      const { data: connRow } = await supabase
        .from("gmail_connections")
        .select("id")
        .ilike("email_address", targetAccountEmail)
        .eq("is_connected", true)
        .maybeSingle();
      if (connRow?.id) {
        const connSecret = await getGmailConnectionSecret(supabase, { connectionId: connRow.id });
        if (connSecret && connSecret.is_connected && !candidateConnections.some(x => x.id === connSecret.id)) {
          candidateConnections.push(connSecret);
        }
      }
    }
    if (user?.id) {
      const userConn = await getConnection(supabase, user.id);
      if (userConn && userConn.is_connected && !candidateConnections.some(x => x.id === userConn.id)) {
        candidateConnections.push(userConn);
      }
    }
    if (canAccessAllMailboxes) {
      const allConns = await listGmailConnectionSecrets(supabase, {});
      for (const c of allConns) {
        if (c.is_connected && !candidateConnections.some(x => x.id === c.id)) {
          candidateConnections.push(c);
        }
      }
    }

    if (candidateConnections.length === 0) {
      return json({ success: false, code: "NO_GMAIL_CONNECTED" }, 200);
    }

    // 2. Search candidate accounts for message or thread
    let activeConnection: GmailConnectionSecret | null = null;
    let foundData: any = null;
    let isThreadResult = false;
    let fetchErrorText = "";

    for (const conn of candidateConnections) {
      try {
        const accessToken = await getValidAccessToken(supabase, conn as any);
        // Try messageId first if provided
        if (messageId) {
          const resp = await fetch(
            `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(messageId)}?format=full`,
            { headers: { Authorization: `Bearer ${accessToken}` } }
          );
          if (resp.ok) {
            foundData = await resp.json();
            activeConnection = conn;
            isThreadResult = false;
            break;
          } else if (resp.status !== 404) {
            fetchErrorText = await resp.text();
          }
        }

        // Try threadId if messageId failed or was not provided
        if (threadId) {
          const resp = await fetch(
            `https://gmail.googleapis.com/gmail/v1/users/me/threads/${encodeURIComponent(threadId)}?format=full`,
            { headers: { Authorization: `Bearer ${accessToken}` } }
          );
          if (resp.ok) {
            foundData = await resp.json();
            activeConnection = conn;
            isThreadResult = true;
            break;
          } else if (resp.status !== 404) {
            fetchErrorText = await resp.text();
          }
        }
      } catch (err: any) {
        console.warn(`[gmail-inbox-message] Error checking connection ${conn.email_address}:`, err);
      }
    }

    if (!foundData || !activeConnection) {
      if (conversationId) {
        const { data: dbMsgs } = await supabase
          .from("enquiry_conversation_messages")
          .select("id, external_message_id, sender_address, recipient_addresses, subject, body_text, body_html, direction, created_at, metadata")
          .eq("conversation_id", conversationId)
          .order("created_at", { ascending: true });
        if (dbMsgs && dbMsgs.length > 0) {
          const fallbackThread = dbMsgs.map(m => {
            const meta = (m.metadata || {}) as Record<string, unknown>;
            return {
              messageId: m.external_message_id || m.id,
              threadId: (meta.gmail_thread_id as string) || "",
              from: m.sender_address || "",
              to: (m.recipient_addresses || []).join(", "),
              subject: m.subject || "",
              date: m.created_at,
              body: m.body_text || m.body_html || "",
              bodyHtml: m.body_html || undefined,
              attachments: [] as any[],
              hasAttachments: false,
              direction: m.direction,
            };
          });
          const primaryMsg = fallbackThread[fallbackThread.length - 1];
          return json({
            success: true,
            isThread: true,
            message: primaryMsg,
            thread: fallbackThread,
            source: "database_fallback",
            mailbox: targetAccountEmail || "sales@avira.co.id",
          });
        }
      }
      return json({
        success: false,
        code: "MESSAGE_NOT_FOUND",
        error: fetchErrorText || "Message or thread not found in connected Gmail accounts.",
        attemptedAccounts: candidateConnections.map(c => c.email_address),
      }, 404);
    }

    // 3. Assemble chronological thread messages
    let thread_messages: ReturnType<typeof safeMessage>[] = [];
    let primaryMessageRaw: any = null;

    if (isThreadResult) {
      const all = (foundData.messages || []) as any[];
      // Sort oldest to newest by internalDate
      all.sort((a, b) => Number(a.internalDate || 0) - Number(b.internalDate || 0));
      primaryMessageRaw = messageId ? all.find(m => m.id === messageId) || all[all.length - 1] : all[all.length - 1];
      thread_messages = all.map(m => safeMessage(m, null));
    } else {
      primaryMessageRaw = foundData;
      const targetThreadId = threadId || primaryMessageRaw?.threadId;
      if (targetThreadId && (includeThread || !messageId)) {
        try {
          const accessToken = await getValidAccessToken(supabase, activeConnection as any);
          const threadUrl = `https://gmail.googleapis.com/gmail/v1/users/me/threads/${encodeURIComponent(targetThreadId)}?format=full`;
          const threadResp = await fetch(threadUrl, { headers: { Authorization: `Bearer ${accessToken}` } });
          if (threadResp.ok) {
            const threadData = await threadResp.json();
            const all = (threadData.messages || []) as any[];
            all.sort((a, b) => Number(a.internalDate || 0) - Number(b.internalDate || 0));
            thread_messages = all.map(m => safeMessage(m, null));
          }
        } catch (err) {
          console.warn("[gmail-inbox-message] Failed to fetch full thread:", err);
        }
      }
      if (thread_messages.length === 0) {
        thread_messages = [safeMessage(primaryMessageRaw, null)];
      }
    }

    const { data: linked } = await supabase
      .from("crm_email_inbox")
      .select("message_id,converted_to_inquiry")
      .eq("message_id", primaryMessageRaw?.id)
      .maybeSingle();

    const primary = safeMessage(primaryMessageRaw, linked?.converted_to_inquiry || null);

    // 4. Enrich attachments with storage paths from crm_product_documents
    const allMsgIds = thread_messages.map(m => m.messageId).filter(Boolean);
    if (allMsgIds.length > 0) {
      const { data: storedDocs } = await supabase
        .from("crm_product_documents")
        .select("id, original_file_name, display_file_name, storage_path, storage_bucket, document_type, source_gmail_message_id")
        .in("source_gmail_message_id", allMsgIds);

      for (const msg of thread_messages) {
        for (const att of msg.attachments) {
          const fname = (att.filename || "").toLowerCase();
          const matched = storedDocs?.find(
            (d: any) =>
              (d.source_gmail_message_id === msg.messageId &&
                ((d.display_file_name || d.original_file_name || "").toLowerCase() === fname)) ||
              (d.display_file_name || d.original_file_name || "").toLowerCase() === fname
          );
          if (matched?.storage_path) {
            (att as any).storagePath = matched.storage_path;
            (att as any).storageBucket = matched.storage_bucket || "crm-documents";
            (att as any).documentType = matched.document_type || "OTHER";
          }
        }
      }
    }

    return json({
      success: true,
      emailAddress: activeConnection.email_address,
      message: primary,
      thread_messages,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "UNKNOWN_ERROR";
    const status = message === "MISSING_AUTH" || message === "INVALID_AUTH" ? 401 : 500;
    return json({ success: false, code: message }, status);
  }
});
