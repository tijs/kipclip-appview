/**
 * TAP webhook receiver.
 *
 * Stub for U9. Full event parser + dispatcher lands in U11.
 * Returns 200 with a parsed-event count so the wiring is testable end-to-end
 * before the per-event upsert path is in.
 */

export async function handleWebhookRequest(req: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const events = Array.isArray((body as { events?: unknown[] })?.events)
    ? (body as { events: unknown[] }).events
    : [];

  return Response.json({ received: events.length });
}
