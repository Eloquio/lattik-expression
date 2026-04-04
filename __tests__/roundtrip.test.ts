import { describe, it, expect } from "vitest";
import { parse } from "../src/parser/parse.js";
import { emitSql } from "../src/emitter/emit-sql.js";

/**
 * Round-trip test: parse → emit → parse → emit.
 * The two emitted strings should be identical (canonical form).
 */
function roundtrip(input: string) {
  const r1 = parse(input);
  expect(r1.errors).toEqual([]);
  const sql1 = emitSql(r1.expr!);

  const r2 = parse(sql1);
  expect(r2.errors).toEqual([]);
  const sql2 = emitSql(r2.expr!);

  expect(sql2).toBe(sql1);
  return sql1;
}

describe("roundtrip", () => {
  const cases = [
    // literals
    ["42", "42"],
    ["3.14", "3.14"],
    ["'hello'", "'hello'"],
    ["TRUE", "TRUE"],
    ["NULL", "NULL"],

    // column refs
    ["amount", "amount"],
    ["t.amount", "t.amount"],

    // arithmetic
    ["a + b", "a + b"],
    ["a + b * c", "a + b * c"],
    ["(a + b) * c", "(a + b) * c"],
    ["-a", "-a"],

    // comparison
    ["a > 0", "a > 0"],
    ["a != b", "a != b"],

    // logical
    ["a AND b", "a AND b"],
    ["NOT a", "NOT a"],

    // predicates
    ["a IS NULL", "a IS NULL"],
    ["a IS NOT NULL", "a IS NOT NULL"],
    ["a BETWEEN 1 AND 10", "a BETWEEN 1 AND 10"],
    ["a IN (1, 2, 3)", "a IN (1, 2, 3)"],
    ["name LIKE '%foo%'", "name LIKE '%foo%'"],

    // CASE
    [
      "CASE WHEN a > 0 THEN 'pos' ELSE 'neg' END",
      "CASE WHEN a > 0 THEN 'pos' ELSE 'neg' END",
    ],

    // CAST
    ["CAST(a AS INT64)", "CAST(a AS INT64)"],

    // functions
    ["COALESCE(a, 0)", "COALESCE(a, 0)"],

    // aggregates
    ["SUM(amount)", "SUM(amount)"],
    ["COUNT(*)", "COUNT(*)"],
    ["COUNT(DISTINCT user_id)", "COUNT(DISTINCT user_id)"],

    // window
    [
      "SUM(amount) OVER (PARTITION BY user_id ORDER BY date)",
      "SUM(amount) OVER (PARTITION BY user_id ORDER BY date)",
    ],
  ];

  for (const [input, expected] of cases) {
    it(`${input}`, () => {
      const result = roundtrip(input);
      expect(result).toBe(expected);
    });
  }
});
