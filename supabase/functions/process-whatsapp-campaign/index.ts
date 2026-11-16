import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.57.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey, X-WhatsApp-Worker-Secret",
};

interface CampaignProcessPayload {
  campaignId?: string;
  action?: 'start' | 'pause' | 'resume' | 'cancel' | 'process_next';
}

async function refreshCampaignCounts(supabase: any, campaignId: string) {
  const { data } = await supabase.rpc("refresh_whatsapp_campaign_counts", {
    p_campaign_id: campaignId,
  });
  return Array.isArray(data) ? data[0] : null;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  const executionId = crypto.randomUUID();
  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const supabase = createClient(supabaseUrl, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  try {
    const authHeader = req.headers.get("Authorization") || "";
    const jwt = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
    const workerSecretHeader = req.headers.get("X-WhatsApp-Worker-Secret") || "";
    const expectedWorkerSecret = Deno.env.get("WHATSAPP_WORKER_SECRET");

    const isInternal = Boolean(expectedWorkerSecret && workerSecretHeader === expectedWorkerSecret);

    // Verify authentication if not internal self-schedule call
    if (!isInternal) {
      if (!jwt) {
        return new Response(
          JSON.stringify({ success: false, error: "Missing Authorization header" }),
          { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
      const userClient = createClient(supabaseUrl, Deno.env.get("SUPABASE_ANON_KEY")!, {
        global: { headers: { Authorization: `Bearer ${jwt}` } },
      });
      const { data: authData, error: authError } = await userClient.auth.getUser();
      if (authError || !authData?.user) {
        return new Response(
          JSON.stringify({ success: false, error: "Invalid or expired session" }),
          { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
    }

    const body: CampaignProcessPayload = await req.json().catch(() => ({}));
    const { campaignId, action = 'process_next' } = body;

    if (!campaignId) {
      // Find due campaigns
      const { data: dueCampaigns } = await supabase
        .from("whatsapp_campaigns")
        .select("id")
        .eq("status", "in_progress")
        .lte("next_run_at", new Date().toISOString())
        .order("next_run_at", { ascending: true })
        .limit(1);

      if (!dueCampaigns || dueCampaigns.length === 0) {
        return new Response(
          JSON.stringify({ success: true, processed: 0, message: "No campaigns due for dispatch" }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
      return await processCampaign(supabase, dueCampaigns[0].id, executionId, expectedWorkerSecret);
    }

    // Handle pause/resume/cancel actions
    if (action === 'pause') {
      await supabase
        .from("whatsapp_campaigns")
        .update({ status: 'paused', next_run_at: null, worker_lock_until: null, worker_lock_id: null })
        .eq("id", campaignId);
      return new Response(
        JSON.stringify({ success: true, campaignId, status: 'paused' }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (action === 'cancel') {
      await supabase
        .from("whatsapp_campaigns")
        .update({ status: 'cancelled', next_run_at: null, completed_at: new Date().toISOString(), worker_lock_until: null, worker_lock_id: null })
        .eq("id", campaignId);
      await supabase
        .from("whatsapp_campaign_recipients")
        .update({ status: 'cancelled' })
        .eq("campaign_id", campaignId)
        .eq("status", "pending");
      return new Response(
        JSON.stringify({ success: true, campaignId, status: 'cancelled' }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (action === 'start' || action === 'resume') {
      await supabase
        .from("whatsapp_campaigns")
        .update({
          status: 'in_progress',
          started_at: new Date().toISOString(),
          next_run_at: new Date().toISOString(),
          worker_lock_until: null,
          worker_lock_id: null,
        })
        .eq("id", campaignId);
      return await processCampaign(supabase, campaignId, executionId, expectedWorkerSecret);
    }

    return await processCampaign(supabase, campaignId, executionId, expectedWorkerSecret);
  } catch (err: any) {
    console.error("[process-whatsapp-campaign] Fatal error:", err);
    return new Response(
      JSON.stringify({ success: false, error: err.message || "Internal server error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});

async function processCampaign(supabase: any, campaignId: string, executionId: string, workerSecret: string) {
  const lockDurationMs = 60_000;
  const lockUntil = new Date(Date.now() + lockDurationMs).toISOString();

  // 1. Acquire execution lock
  const { data: lockAcquired, error: lockErr } = await supabase
    .from("whatsapp_campaigns")
    .update({
      worker_lock_id: executionId,
      worker_lock_until: lockUntil,
      worker_started_at: new Date().toISOString(),
    })
    .eq("id", campaignId)
    .or(`worker_lock_until.is.null,worker_lock_until.lt.${new Date().toISOString()}`)
    .select("*")
    .maybeSingle();

  if (lockErr || !lockAcquired) {
    return new Response(
      JSON.stringify({ success: false, error: "Campaign is currently locked by another worker process" }),
      { status: 409, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  const campaign = lockAcquired;

  // If campaign was paused or cancelled in DB, release lock and abort
  if (campaign.status === 'paused' || campaign.status === 'cancelled') {
    await supabase
      .from("whatsapp_campaigns")
      .update({ worker_lock_id: null, worker_lock_until: null })
      .eq("id", campaignId);
    return new Response(
      JSON.stringify({ success: true, message: `Campaign is ${campaign.status}` }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  // 2. Fetch the next pending recipient (exactly ONE recipient per 20-second step)
  const { data: recipients, error: recErr } = await supabase
    .from("whatsapp_campaign_recipients")
    .select("*")
    .eq("campaign_id", campaignId)
    .eq("status", "pending")
    .order("created_at", { ascending: true })
    .limit(1);

  if (recErr) {
    throw new Error(`Failed to query campaign recipients: ${recErr.message}`);
  }

  const recipient = recipients && recipients.length > 0 ? recipients[0] : null;

  if (!recipient) {
    // All recipients processed! Compute final counts
    const counts = await refreshCampaignCounts(supabase, campaignId);
    const sent = Number(counts?.sent_count || 0);
    const failed = Number(counts?.failed_count || 0);
    const finalStatus = failed === 0 ? "completed" : sent === 0 ? "failed" : "partial";

    await supabase
      .from("whatsapp_campaigns")
      .update({
        status: finalStatus,
        completed_at: new Date().toISOString(),
        worker_finished_at: new Date().toISOString(),
        worker_lock_id: null,
        worker_lock_until: null,
        next_run_at: null,
      })
      .eq("id", campaignId);

    return new Response(
      JSON.stringify({ success: true, status: finalStatus, message: "Campaign complete", counts }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  // Mark recipient as 'sending'
  await supabase
    .from("whatsapp_campaign_recipients")
    .update({ status: 'sending', updated_at: new Date().toISOString() })
    .eq("id", recipient.id);

  // 3. Dispatch via Official Meta WhatsApp Cloud API (or adapter fallback)
  const metaPhoneNumberId = Deno.env.get("META_PHONE_NUMBER_ID") || "";
  const metaAccessToken = Deno.env.get("META_ACCESS_TOKEN") || "";
  const adapterUrl = Deno.env.get("WHATSAPP_ADAPTER_URL") || "";

  let sendSuccess = false;
  let externalMessageId = "";
  let sendError: string | null = null;
  let providerResp: any = null;

  const cleanPhone = recipient.phone.replace(/\D/g, "");
  const captionText = recipient.personalized_caption || campaign.message_template;

  try {
    if (metaPhoneNumberId && metaAccessToken) {
      // Official Meta WhatsApp Cloud API endpoint
      const metaUrl = `https://graph.facebook.com/v21.0/${metaPhoneNumberId}/messages`;
      let payload: Record<string, any>;

      if (campaign.attachment_url) {
        const isImage = campaign.attachment_type === 'IMAGE' || /\.(jpg|jpeg|png|webp)$/i.test(campaign.attachment_filename || '');
        if (isImage) {
          payload = {
            messaging_product: "whatsapp",
            recipient_type: "individual",
            to: cleanPhone,
            type: "image",
            image: {
              link: campaign.attachment_url,
              caption: captionText,
            },
          };
        } else {
          payload = {
            messaging_product: "whatsapp",
            recipient_type: "individual",
            to: cleanPhone,
            type: "document",
            document: {
              link: campaign.attachment_url,
              filename: campaign.attachment_filename || "Document.pdf",
              caption: captionText,
            },
          };
        }
      } else {
        payload = {
          messaging_product: "whatsapp",
          recipient_type: "individual",
          to: cleanPhone,
          type: "text",
          text: {
            preview_url: false,
            body: captionText,
          },
        };
      }

      const res = await fetch(metaUrl, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${metaAccessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      });

      providerResp = await res.json().catch(() => ({}));
      if (res.ok && providerResp?.messages?.[0]?.id) {
        sendSuccess = true;
        externalMessageId = providerResp.messages[0].id;
      } else {
        sendError = providerResp?.error?.message || `Meta Cloud API HTTP ${res.status}`;
      }
    } else if (adapterUrl) {
      // OpenWA / Local Gateway Fallback
      const res = await fetch(`${adapterUrl}/api/messages/send`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${Deno.env.get("WHATSAPP_ADAPTER_API_KEY") || ""}`,
        },
        body: JSON.stringify({
          to: recipient.phone,
          text: captionText,
          options: {
            caption: captionText,
            documentUrl: campaign.attachment_type !== 'IMAGE' ? campaign.attachment_url : undefined,
            imageUrl: campaign.attachment_type === 'IMAGE' ? campaign.attachment_url : undefined,
            filename: campaign.attachment_filename,
          },
        }),
      });
      providerResp = await res.json().catch(() => ({}));
      if (res.ok && providerResp?.success) {
        sendSuccess = true;
        externalMessageId = providerResp.messageId || `wa_${Date.now()}`;
      } else {
        sendError = providerResp?.error || `Adapter HTTP ${res.status}`;
      }
    } else {
      sendError = "Meta WhatsApp Cloud API credentials (META_PHONE_NUMBER_ID, META_ACCESS_TOKEN) are not configured on server.";
    }
  } catch (err: any) {
    sendError = err.message || "Failed to reach WhatsApp gateway";
  }

  const nowIso = new Date().toISOString();

  // 4. Update recipient record
  if (sendSuccess) {
    await supabase
      .from("whatsapp_campaign_recipients")
      .update({
        status: "sent",
        message_id: externalMessageId,
        sent_at: nowIso,
        provider_response: providerResp,
        error_code: null,
        error_message: null,
        updated_at: nowIso,
      })
      .eq("id", recipient.id);
  } else {
    await supabase
      .from("whatsapp_campaign_recipients")
      .update({
        status: "failed",
        failed_at: nowIso,
        error_code: "SEND_FAILED",
        error_message: sendError || "Unknown send error",
        provider_response: providerResp,
        updated_at: nowIso,
      })
      .eq("id", recipient.id);
  }

  // Refresh counts
  await refreshCampaignCounts(supabase, campaignId);

  // 5. Enforce minimum 20-second delay & self-schedule next execution
  const pacingSeconds = Math.max(campaign.processing_delay_seconds || 20, 20);
  const nextRunDate = new Date(Date.now() + pacingSeconds * 1000);

  // Release lock and set next_run_at
  await supabase
    .from("whatsapp_campaigns")
    .update({
      worker_lock_id: null,
      worker_lock_until: null,
      worker_finished_at: nowIso,
      next_run_at: nextRunDate.toISOString(),
      updated_at: nowIso,
    })
    .eq("id", campaignId);

  // Self-Schedule the next step using EdgeRuntime.waitUntil:
  // This continues automatically even when the client computer/browser is completely closed!
  if (typeof EdgeRuntime !== "undefined" && EdgeRuntime.waitUntil) {
    EdgeRuntime.waitUntil(
      (async () => {
        // Wait the full pacing delay
        await new Promise((r) => setTimeout(r, pacingSeconds * 1000));
        const nextUrl = `${supabaseUrl}/functions/v1/process-whatsapp-campaign`;
        await fetch(nextUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-WhatsApp-Worker-Secret": workerSecret,
          },
          body: JSON.stringify({ campaignId }),
        }).catch((e) => console.error("[process-whatsapp-campaign] Self-schedule error:", e));
      })()
    );
  }

  return new Response(
    JSON.stringify({
      success: true,
      processedRecipientId: recipient.id,
      recipientPhone: recipient.phone,
      sent: sendSuccess,
      messageId: externalMessageId,
      nextRunAt: nextRunDate.toISOString(),
    }),
    { headers: { ...corsHeaders, "Content-Type": "application/json" } }
  );
}

