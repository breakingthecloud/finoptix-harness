/**
 * FinOptix Observability — Qhaway wiring + feedback loop (Bloque 3)
 *
 * Integrates QhawayTinkuyPlugin (tracing spans per iteration/tool/complete),
 * adds a feedback loop (thumbs up/down → writes rating on the session span),
 * and exposes ratingStats() aggregations that feed the adaptive-classifier
 * (R1/R2 done — no DynamoDB; R3 weekly export from these spans).
 *
 * Stack: @carloscortezcloud/qhaway (trace + tinkuy plugin + cost rating)
 */

import { QhawayTinkuyPlugin } from '@carloscortezcloud/qhaway/tinkuy';
import type { QhawaySpan } from '@carloscortezcloud/qhaway';
import { ratingStats } from '@carloscortezcloud/qhaway/cost';
import type { AgentConfig } from '@carloscortezcloud/tinkuy-agent';

export interface ObservabilityConfig {
  agentName: string;
  captureToolPayloads?: boolean;
  /** optional durable backend (D1/KV/HTTP). A snapshot is always kept for stats. */
  backend?: QhawayStorageLike;
}

export interface QhawayStorageLike {
  write(span: QhawaySpan): Promise<void>;
  query?(filters?: Partial<QhawaySpan>, limit?: number): Promise<QhawaySpan[]>;
  close?(): Promise<void>;
}

export interface FinOptixObs {
  plugin: QhawayTinkuyPlugin;
  /** attach tracing + feedback hooks into an Agent config */
  attach: (config: AgentConfig) => AgentConfig;
  /** user rates a previous response — writes rating on that session's span */
  rate: (sessionId: string, rating: 1 | -1 | 0, message?: string, userId?: string) => Promise<void>;
  /** aggregate thumbs stats (feeds adaptive-classifier R1/R2) */
  stats: () => ReturnType<typeof ratingStats>;
  /** all spans (for R3 weekly export to S3 routing_training_data) */
  allSpans: () => QhawaySpan[];
  /** rated spans only (for retrain) */
  ratedSpans: () => QhawaySpan[];
}

/** Snapshot storage: keeps every span in memory AND mirrors to optional backend. */
export class SnapshotStorage implements QhawayStorageLike {
  private spans: QhawaySpan[] = [];
  constructor(private backend?: QhawayStorageLike) {}
  async write(span: QhawaySpan): Promise<void> {
    this.spans.push(span);
    await this.backend?.write(span);
  }
  async query(): Promise<QhawaySpan[]> {
    return [...this.spans];
  }
  snapshot(): QhawaySpan[] {
    return [...this.spans];
  }
}

export function createObservability(cfg: ObservabilityConfig): FinOptixObs {
  const storage = new SnapshotStorage(cfg.backend);
  const plugin = new QhawayTinkuyPlugin({
    storage: storage as never,
    agentName: cfg.agentName,
    captureToolPayloads: cfg.captureToolPayloads ?? false,
  });

  return {
    plugin,

    attach(config: AgentConfig): AgentConfig {
      const traceHooks = plugin.hooks;
      return {
        ...config,
        onIteration: (e) => {
          void traceHooks.onIteration(e);
          config.onIteration?.(e);
        },
        onToolCall: (e) => {
          void traceHooks.onToolCall(e);
          config.onToolCall?.(e);
        },
        onComplete: (e) => {
          void traceHooks.onComplete(e);
          config.onComplete?.(e);
        },
        onFeedback: async (e) => {
          await storage.write({
            id: `feedback-${e.session_id}-${e.timestamp}`,
            timestamp: new Date(e.timestamp).toISOString(),
            model: '',
            provider: 'feedback',
            latency_ms: 0,
            tokens_in: 0,
            tokens_out: 0,
            cost_usd: 0,
            session_id: e.session_id,
            agent_id: cfg.agentName,
            user_id: e.user_id,
            rating: e.rating,
            success: true,
            metadata: { message: e.message },
          });
          config.onFeedback?.(e);
        },
      };
    },

    async rate(sessionId: string, rating: 1 | -1 | 0, message?: string, userId?: string) {
      await storage.write({
        id: `feedback-${sessionId}-${Date.now()}`,
        timestamp: new Date().toISOString(),
        model: '',
        provider: 'feedback',
        latency_ms: 0,
        tokens_in: 0,
        tokens_out: 0,
        cost_usd: 0,
        session_id: sessionId,
        agent_id: cfg.agentName,
        user_id: userId,
        rating,
        success: true,
        metadata: { message },
      });
    },

    stats() {
      return ratingStats(storage.snapshot());
    },

    allSpans() {
      return storage.snapshot();
    },

    ratedSpans() {
      return storage.snapshot().filter((s) => s.rating !== undefined);
    },
  };
}