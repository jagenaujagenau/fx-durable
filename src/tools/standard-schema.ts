import { Predicate } from "effect"
import type { Json } from "../domain/json.js"

/**
 * The subset of the Standard Schema (https://standardschema.dev) and
 * Standard JSON Schema interfaces fx-durable consumes. Vendored, as the spec
 * recommends, so validators from Zod, Valibot, ArkType or Effect Schema plug
 * in without fx-durable depending on any of them.
 */
export interface StandardSchemaV1<Input = Json, Output = Input> {
  readonly "~standard": StandardSchemaV1.Props<Input, Output>
}

export declare namespace StandardSchemaV1 {
  interface Props<Input, Output> {
    readonly version: 1
    readonly vendor: string
    readonly validate: (value: Json) => Result<Output> | Promise<Result<Output>>
    readonly types?: { readonly input: Input; readonly output: Output } | undefined
    /** Present when the library also implements Standard JSON Schema. */
    readonly jsonSchema?: JsonSchemaConverter | undefined
  }
  type Result<Output> = SuccessResult<Output> | FailureResult
  interface SuccessResult<Output> {
    readonly value: Output
    readonly issues?: undefined
  }
  interface FailureResult {
    readonly issues: ReadonlyArray<Issue>
  }
  interface Issue {
    readonly message: string
    readonly path?: ReadonlyArray<PropertyKey | { readonly key: PropertyKey }> | undefined
  }
  type InferOutput<S extends StandardSchemaV1> = NonNullable<S["~standard"]["types"]>["output"]
}

export interface JsonSchemaConverter {
  readonly input: (options: { readonly target: "draft-2020-12" | "draft-07" }) => object
}

export const formatIssues = (issues: ReadonlyArray<StandardSchemaV1.Issue>): string =>
  issues
    .map((issue) => {
      const path = (issue.path ?? [])
        .map((segment) => String(Predicate.hasProperty(segment, "key") ? segment.key : segment))
        .join(".")
      return path ? `${path}: ${issue.message}` : issue.message
    })
    .join("; ")
