/**
 * Event emitter/consumer and RPC detection for the manifest.
 *
 * The current analyzer does not surface message-bus events or gRPC/RPC service
 * definitions as structured data, so per spec-05's conservative rule these are
 * emitted as empty arrays rather than guessed. The schema and federation index
 * already accommodate them, so a later analyzer change can populate them
 * without a manifest-schema bump.
 *
 * TODO(spec-05-followup): surface events_emitted / events_consumed from analyzer.
 * TODO(spec-05-followup): surface rpc_endpoints (gRPC service/method) from analyzer.
 */

export interface ManifestEvent {
  name: string;
  schema_ref?: string | null;
  emitter?: string | null;
}

export interface ManifestConsumedEvent {
  name: string;
  handler: string | null;
}

export interface ManifestRpcEndpoint {
  kind: string;
  service: string;
  method: string;
  handler: string | null;
}

export function deriveEventsEmitted(): ManifestEvent[] {
  return [];
}

export function deriveEventsConsumed(): ManifestConsumedEvent[] {
  return [];
}

export function deriveRpcEndpoints(): ManifestRpcEndpoint[] {
  return [];
}
