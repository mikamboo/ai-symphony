import { describe, it, expect } from "vitest";
import { LINEAR_SCOPED_ISSUES_QUERY, linearIssuesByIdsQuery } from "./linear.js";

/**
 * Regression coverage for the class of bug that shipped once already: a hand-written GraphQL
 * query field/argument that doesn't exist in Linear's real schema (`Issue.inverseRelations` does
 * not accept a `filter` argument — SPEC.md 11.2 requires adapters to be validated against the
 * real provider, not just unit-tested against our own assumptions about it).
 *
 * This talks to the real `api.linear.app/graphql` endpoint. It needs no API key: GraphQL schema
 * validation happens before authentication is checked, so a syntactically/schematically invalid
 * query fails with `GRAPHQL_VALIDATION_FAILED` even with a bogus token, while a valid query fails
 * with a plain authentication error instead. That asymmetry is what this test asserts on.
 *
 * Opt-in only (SPEC.md 17.8 Real Integration Profile: skipped by default, not silently "passed",
 * requires network egress to a third party this repo's default test run shouldn't depend on).
 * Run explicitly with:
 *   SYMPHONY_TEST_LIVE_LINEAR_SCHEMA=1 pnpm vitest run src/tracker/linear.schema.test.ts
 */
const live = process.env.SYMPHONY_TEST_LIVE_LINEAR_SCHEMA === "1";

interface GraphQLErrorBody {
  errors?: { message: string; extensions?: { code?: string } }[];
}

async function assertSchemaValid(query: string, variables: Record<string, unknown>): Promise<void> {
  const response = await fetch("https://api.linear.app/graphql", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "schema-validation-probe-invalid-token" },
    body: JSON.stringify({ query, variables })
  });
  const body = (await response.json()) as GraphQLErrorBody;

  const validationError = body.errors?.find((e) => e.extensions?.code === "GRAPHQL_VALIDATION_FAILED");
  if (validationError) {
    throw new Error(`Query is invalid against Linear's live schema: ${validationError.message}`);
  }
}

// describe.skipIf reports these as explicitly SKIPPED (not silently passed) when `live` is
// false, satisfying SPEC.md 17.8's "a skipped real-integration test SHOULD be reported as
// skipped".
describe.skipIf(!live)("Linear adapter queries vs. live schema (SYMPHONY_TEST_LIVE_LINEAR_SCHEMA=1)", () => {
  it("LINEAR_SCOPED_ISSUES_QUERY is schema-valid", async () => {
    await assertSchemaValid(LINEAR_SCOPED_ISSUES_QUERY, { first: 1, after: null, filter: {} });
  });

  it("linearIssuesByIdsQuery(...) is schema-valid", async () => {
    await assertSchemaValid(linearIssuesByIdsQuery(1), { ids: ["00000000-0000-0000-0000-000000000000"] });
  });
});
