import { canonicalJson, decodeUtf8, parseJsonObject } from './json.ts';
import type { Receiver } from './receiver.ts';
import { errorResponse, outcomeResponse } from './responses.ts';
import { verifySignature } from './signature.ts';
import { validateEvent } from './webhookEvent.ts';

export type WebhookHandlerDependencies = {
  receiver: Receiver;
  secret: string;
  now: () => Date;
};

const SIGNATURE_HEADER = 'Webhook-Signature';

/** POST /webhooks: signature, then body validation, then the receiver (idempotency and apply). */
export async function handleWebhook(request: Request, dependencies: WebhookHandlerDependencies): Promise<Response> {
  const rawBody = new Uint8Array(await request.arrayBuffer());
  const signature = verifySignature({
    header: request.headers.get(SIGNATURE_HEADER),
    rawBody,
    secret: dependencies.secret,
    nowMilliseconds: dependencies.now().getTime(),
  });
  if (!signature.ok) return errorResponse(signature.error);

  const text = decodeUtf8(rawBody);
  if (!text.ok) return errorResponse(text.error);
  const body = parseJsonObject(text.value);
  if (!body.ok) return errorResponse(body.error);
  const event = validateEvent(body.value);
  if (!event.ok) return errorResponse(event.error);

  const received = dependencies.receiver.receive(event.value, canonicalJson(body.value));
  return received.ok ? outcomeResponse(received.value) : errorResponse(received.error);
}

