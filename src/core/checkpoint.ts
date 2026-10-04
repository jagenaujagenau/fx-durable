import { Context, Effect, Layer } from "effect"
import type { StorageError } from "./errors.js"
import { EventLog } from "./events.js"
import { IdGenerator, now } from "./ids.js"
import type { AgentCheckpoint } from "./schema.js"
import { Storage } from "./storage.js"

/**
 * Opaque libfx checkpoints plus the host configuration needed to restore
 * them. The bytes are never deserialized or inspected here.
 */
export interface CheckpointStoreInterface {
  readonly latest: (agentId: string) => Effect.Effect<AgentCheckpoint | null, StorageError>
  /**
   * Write the next checkpoint. Must run inside the transaction that also
   * completes the turn, so a checkpoint never exists for an unfinished turn.
   */
  readonly write: (fields: {
    readonly agentId: string
    readonly turnId: string
    readonly submissionId: string
    readonly taskId: string
    readonly runtimeId: string
    readonly model: string
    readonly data: Uint8Array
    readonly expectedPrevious: number | null
  }) => Effect.Effect<AgentCheckpoint, StorageError>
}

export class CheckpointStore extends Context.Service<CheckpointStore, CheckpointStoreInterface>()(
  "fx-durable/CheckpointStore"
) {}

export const layer = Layer.effect(
  CheckpointStore,
  Effect.gen(function* () {
    const storage = yield* Storage
    const events = yield* EventLog
    const ids = yield* IdGenerator

    const write = Effect.fn("CheckpointStore.write")(function* (fields: Parameters<CheckpointStoreInterface["write"]>[0]) {
      const previous = yield* storage.latestCheckpoint(fields.agentId)
      const previousSeq = previous?.sequence ?? null
      if (previousSeq !== fields.expectedPrevious) {
        // A checkpoint landed that this turn did not start from: a programmer error.
        return yield* Effect.die(
          new Error(
            `checkpoint sequence conflict for ${fields.agentId}: expected ${fields.expectedPrevious}, found ${previousSeq}`
          )
        )
      }
      const checkpoint: AgentCheckpoint = {
        id: yield* ids.next("ckpt"),
        agentId: fields.agentId,
        sequence: (previousSeq ?? 0) + 1,
        fxCheckpoint: fields.data,
        runtimeId: fields.runtimeId,
        model: fields.model,
        createdAt: yield* now
      }
      yield* storage.insertCheckpoint(checkpoint)
      yield* events.append({
        agentId: fields.agentId,
        submissionId: fields.submissionId,
        turnId: fields.turnId,
        taskId: fields.taskId,
        type: "checkpoint.created",
        payload: { sequence: checkpoint.sequence, bytes: fields.data.byteLength }
      })
      return checkpoint
    })

    return CheckpointStore.of({ latest: (agentId) => storage.latestCheckpoint(agentId), write })
  })
)
