import { query, transaction } from "@/lib/db";
import { sendGoogleEmail } from "@/lib/integrations/google";

type QueuedEmail = {
  id: string;
  project_id: string;
  contact_id: string;
  recipient: string;
  subject: string;
  body: string;
  attempt_count: number;
};

export async function processNextOutboundEmail() {
  const message = await transaction(async (client) => {
    const claimed = await client.query<QueuedEmail>(
      `WITH candidate AS (
         SELECT id FROM outbound_messages
         WHERE (status='queued' AND attempt_count < 5 AND next_attempt_at <= NOW()) OR
           (status='sending' AND sending_started_at < NOW()-INTERVAL '10 minutes')
         ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1
       )
       UPDATE outbound_messages m SET status='sending',attempt_count=m.attempt_count+1,
         sending_started_at=NOW(),updated_at=NOW()
       FROM candidate c WHERE m.id=c.id
       RETURNING m.id,m.project_id,m.contact_id,m.recipient,m.subject,m.body,m.attempt_count`,
    );
    return claimed.rows[0] ?? null;
  });
  if (!message) return null;

  try {
    const eligible = await query(
      `SELECT 1 FROM sales_leads l JOIN contacts c ON c.id=l.contact_id
       WHERE c.id=$1 AND l.project_id=$2 AND l.stage IN ('new','qualified','proposal')
         AND LOWER(c.email)=LOWER($3)
         AND NOT EXISTS (SELECT 1 FROM contact_channel_preferences p WHERE p.contact_id=c.id AND p.channel='email' AND p.status='opted_out')`,
      [message.contact_id, message.project_id, message.recipient],
    );
    if (!eligible.rowCount) {
      await query(`UPDATE outbound_messages SET status='failed',last_error='Contact is no longer an active lead or has opted out.',sending_started_at=NULL,updated_at=NOW()
        WHERE id=$1 AND status='sending'`, [message.id]);
      return { id: message.id, status: "failed" as const };
    }

    const sent = await sendGoogleEmail({ idempotencyId: message.id, to: message.recipient, subject: message.subject, body: message.body });
    await transaction(async (client) => {
      await client.query(`UPDATE outbound_messages SET status='sent',provider_message_id=$2,provider_thread_id=$3,
        sent_at=NOW(),updated_at=NOW(),sending_started_at=NULL,last_error=NULL WHERE id=$1 AND status='sending'`, [message.id, sent.id, sent.threadId]);
      await client.query(`INSERT INTO events (project_id,source,event_type,title,severity,payload)
        VALUES ($1,'sales','sales_email_sent','Approved sales email sent','info',$2::jsonb)`,
        [message.project_id, JSON.stringify({ outbound_message_id: message.id, contact_id: message.contact_id })]);
    });
    return { id: message.id, status: "sent" as const };
  } catch (error) {
    const detail = error instanceof Error ? error.message.slice(0, 300) : "Gmail send failed.";
    const permanent = /COMPANYOS_POSTAL_ADDRESS|Reconnect Google|HTTP 4\d\d|no longer an active lead|opted out/i.test(detail);
    const status = permanent || message.attempt_count >= 5 ? "failed" : "queued";
    const retrySeconds = Math.min(900, 15 * 2 ** Math.max(0, message.attempt_count - 1));
    await query(`UPDATE outbound_messages SET status=$2,last_error=$3,sending_started_at=NULL,
      next_attempt_at=CASE WHEN $2='queued' THEN NOW()+($4::text || ' seconds')::interval ELSE next_attempt_at END,updated_at=NOW()
      WHERE id=$1 AND status='sending'`, [message.id, status, detail, retrySeconds]);
    return { id: message.id, status: status as "queued" | "failed" };
  }
}
