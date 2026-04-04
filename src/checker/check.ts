/**
 * Type checker for Lattik expressions.
 *
 * Bottom-up walk: resolves field references, infers types, reports errors.
 */

import type { DataType, ScalarTypeKind } from "../ast/data-types.js";
import {
  dataType,
  isNumeric,
  promoteNumeric,
  commonType,
  isComparable,
} from "../ast/data-types.js";
import type { Expr, Loc } from "../ast/nodes.js";
import { mapExpr } from "../ast/visitor.js";
import type { SchemaContext, FunctionSignature, ColumnInfo } from "./schema.js";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface CheckError {
  loc?: Loc;
  code: string;
  message: string;
}

export interface CheckResult {
  /** AST with `dataType` populated on every node. */
  expr: Expr;
  errors: CheckError[];
}

export function check(expr: Expr, schema: SchemaContext): CheckResult {
  const checker = new TypeChecker(schema);
  const typed = checker.infer(expr);
  return { expr: typed, errors: checker.errors };
}

// ---------------------------------------------------------------------------
// Built-in aggregate return types
// ---------------------------------------------------------------------------

function aggregateReturnType(
  name: string,
  argType: DataType | null
): DataType {
  switch (name) {
    case "COUNT":
      return dataType("int64", false);
    case "SUM":
      if (argType && isNumeric(argType.scalar)) {
        // SUM promotes ints to int64
        const s = argType.scalar === "int32" ? "int64" : argType.scalar;
        return dataType(s, argType.nullable);
      }
      return dataType("double", true);
    case "AVG":
      return dataType("double", true);
    case "MIN":
    case "MAX":
    case "FIRST":
    case "LAST":
    case "ANY_VALUE":
      return argType ?? dataType("unknown", true);
    case "COLLECT_LIST":
    case "COLLECT_SET":
      return dataType("json", false);
    case "STDDEV":
    case "VARIANCE":
      return dataType("double", true);
    default:
      return dataType("unknown", true);
  }
}

// ---------------------------------------------------------------------------
// Built-in scalar functions
// ---------------------------------------------------------------------------

const BUILT_IN_FUNCTIONS: Map<string, FunctionSignature> = new Map([
  [
    "COALESCE",
    {
      name: "COALESCE",
      minArgs: 1,
      maxArgs: Infinity,
      resolve: (args) => {
        let result: ScalarTypeKind = "null";
        for (const a of args) {
          const c = commonType(result, a.scalar);
          if (c) result = c;
        }
        return dataType(result, false);
      },
    },
  ],
  [
    "NULLIF",
    {
      name: "NULLIF",
      minArgs: 2,
      maxArgs: 2,
      resolve: (args) => dataType(args[0]?.scalar ?? "unknown", true),
    },
  ],
  [
    "ABS",
    {
      name: "ABS",
      minArgs: 1,
      maxArgs: 1,
      resolve: (args) => args[0] ?? dataType("unknown", false),
    },
  ],
  [
    "CEIL",
    {
      name: "CEIL",
      minArgs: 1,
      maxArgs: 1,
      resolve: (args) => dataType(args[0]?.scalar ?? "int64", args[0]?.nullable ?? false),
    },
  ],
  [
    "FLOOR",
    {
      name: "FLOOR",
      minArgs: 1,
      maxArgs: 1,
      resolve: (args) => dataType(args[0]?.scalar ?? "int64", args[0]?.nullable ?? false),
    },
  ],
  [
    "ROUND",
    {
      name: "ROUND",
      minArgs: 1,
      maxArgs: 2,
      resolve: (args) => dataType(args[0]?.scalar ?? "double", args[0]?.nullable ?? false),
    },
  ],
  [
    "LENGTH",
    {
      name: "LENGTH",
      minArgs: 1,
      maxArgs: 1,
      resolve: () => dataType("int32", false),
    },
  ],
  [
    "LOWER",
    {
      name: "LOWER",
      minArgs: 1,
      maxArgs: 1,
      resolve: (args) => dataType("string", args[0]?.nullable ?? false),
    },
  ],
  [
    "UPPER",
    {
      name: "UPPER",
      minArgs: 1,
      maxArgs: 1,
      resolve: (args) => dataType("string", args[0]?.nullable ?? false),
    },
  ],
  [
    "TRIM",
    {
      name: "TRIM",
      minArgs: 1,
      maxArgs: 1,
      resolve: (args) => dataType("string", args[0]?.nullable ?? false),
    },
  ],
  [
    "SUBSTRING",
    {
      name: "SUBSTRING",
      minArgs: 2,
      maxArgs: 3,
      resolve: (args) => dataType("string", args[0]?.nullable ?? false),
    },
  ],
  [
    "CONCAT",
    {
      name: "CONCAT",
      minArgs: 1,
      maxArgs: Infinity,
      resolve: () => dataType("string", false),
    },
  ],
  [
    "NOW",
    {
      name: "NOW",
      minArgs: 0,
      maxArgs: 0,
      resolve: () => dataType("timestamp", false),
    },
  ],
  [
    "CURRENT_DATE",
    {
      name: "CURRENT_DATE",
      minArgs: 0,
      maxArgs: 0,
      resolve: () => dataType("date", false),
    },
  ],
  [
    "IF",
    {
      name: "IF",
      minArgs: 3,
      maxArgs: 3,
      resolve: (args) => {
        const t = commonType(
          args[1]?.scalar ?? "unknown",
          args[2]?.scalar ?? "unknown"
        );
        return dataType(t ?? "unknown", true);
      },
    },
  ],
]);

// ---------------------------------------------------------------------------
// Type checker
// ---------------------------------------------------------------------------

class TypeChecker {
  errors: CheckError[] = [];

  private columns: ColumnInfo[];
  private functions: Map<string, FunctionSignature>;

  constructor(schema: SchemaContext) {
    this.columns = schema.columns;
    this.functions = new Map([
      ...BUILT_IN_FUNCTIONS,
      ...(schema.functions ?? new Map()),
    ]);
  }

  infer(expr: Expr): Expr {
    return mapExpr(expr, (node) => this.inferNode(node));
  }

  private inferNode(node: Expr): Expr {
    switch (node.kind) {
      case "IntLiteral":
        return { ...node, dataType: dataType("int64", false) };
      case "FloatLiteral":
        return { ...node, dataType: dataType("double", false) };
      case "StringLiteral":
        return { ...node, dataType: dataType("string", false) };
      case "BoolLiteral":
        return { ...node, dataType: dataType("boolean", false) };
      case "NullLiteral":
        return { ...node, dataType: dataType("null", true) };
      case "Star":
        return node;
      case "ColumnRef":
        return this.inferColumnRef(node);
      case "BinaryExpr":
        return this.inferBinary(node);
      case "UnaryExpr":
        return this.inferUnary(node);
      case "BetweenExpr":
        return { ...node, dataType: dataType("boolean", false) };
      case "InExpr":
        return { ...node, dataType: dataType("boolean", false) };
      case "IsNullExpr":
        return { ...node, dataType: dataType("boolean", false) };
      case "LikeExpr":
        return { ...node, dataType: dataType("boolean", false) };
      case "CaseExpr":
        return this.inferCase(node);
      case "CastExpr":
        return { ...node, dataType: dataType(node.targetType, node.expr.dataType?.nullable ?? false) };
      case "FunctionCall":
        return this.inferFunction(node);
      case "AggregateCall":
        return this.inferAggregate(node);
      case "WindowExpr":
        return { ...node, dataType: node.func.dataType };
    }
  }

  private inferColumnRef(node: Expr & { kind: "ColumnRef" }): Expr {
    const match = this.resolveColumn(node.table, node.column);
    if (!match) {
      const ref = node.table ? `${node.table}.${node.column}` : node.column;
      this.errors.push({
        loc: node.loc,
        code: "UNKNOWN_COLUMN",
        message: `Unknown column '${ref}'`,
      });
      return { ...node, dataType: dataType("unknown", true) };
    }
    return { ...node, dataType: match.dataType };
  }

  private resolveColumn(
    table: string | undefined,
    column: string
  ): ColumnInfo | null {
    const matches = this.columns.filter((c) => {
      if (table && c.table && c.table !== table) return false;
      return c.name === column;
    });
    if (matches.length === 0) return null;
    if (matches.length > 1 && !table) {
      this.errors.push({
        code: "AMBIGUOUS_COLUMN",
        message: `Ambiguous column '${column}' — qualify with table name`,
      });
    }
    return matches[0];
  }

  private inferBinary(node: Expr & { kind: "BinaryExpr" }): Expr {
    const lt = node.left.dataType;
    const rt = node.right.dataType;
    const nullable = (lt?.nullable ?? false) || (rt?.nullable ?? false);

    switch (node.op) {
      case "+":
      case "-":
      case "*":
      case "/":
      case "%": {
        if (lt && rt && lt.scalar !== "null" && rt.scalar !== "null") {
          const promoted = promoteNumeric(lt.scalar, rt.scalar);
          if (promoted === null) {
            this.errors.push({
              loc: node.loc,
              code: "TYPE_MISMATCH",
              message: `Cannot apply '${node.op}' to ${lt.scalar} and ${rt.scalar}`,
            });
            return { ...node, dataType: dataType("unknown", nullable) };
          }
          return { ...node, dataType: dataType(promoted, nullable) };
        }
        return { ...node, dataType: dataType("unknown", nullable) };
      }
      case "||":
        return { ...node, dataType: dataType("string", nullable) };
      case "=":
      case "!=":
      case "<>":
      case "<":
      case "<=":
      case ">":
      case ">=": {
        if (
          lt &&
          rt &&
          lt.scalar !== "null" &&
          rt.scalar !== "null" &&
          lt.scalar !== "unknown" &&
          rt.scalar !== "unknown"
        ) {
          if (!isComparable(lt.scalar) || !isComparable(rt.scalar)) {
            this.errors.push({
              loc: node.loc,
              code: "TYPE_MISMATCH",
              message: `Cannot compare ${lt.scalar} and ${rt.scalar}`,
            });
          }
        }
        return { ...node, dataType: dataType("boolean", false) };
      }
      case "AND":
      case "OR":
        return { ...node, dataType: dataType("boolean", false) };
    }
  }

  private inferUnary(node: Expr & { kind: "UnaryExpr" }): Expr {
    if (node.op === "-") {
      return { ...node, dataType: node.operand.dataType };
    }
    // NOT
    return { ...node, dataType: dataType("boolean", false) };
  }

  private inferCase(node: Expr & { kind: "CaseExpr" }): Expr {
    let resultType: ScalarTypeKind = "null";
    let nullable = false;

    for (const w of node.whens) {
      const t = w.result.dataType;
      if (t) {
        const c = commonType(resultType, t.scalar);
        if (c === null) {
          this.errors.push({
            loc: node.loc,
            code: "TYPE_MISMATCH",
            message: `Incompatible CASE branch types: ${resultType} and ${t.scalar}`,
          });
        } else {
          resultType = c;
        }
        nullable = nullable || t.nullable;
      }
    }

    if (node.elseResult?.dataType) {
      const c = commonType(resultType, node.elseResult.dataType.scalar);
      if (c !== null) resultType = c;
      nullable = nullable || node.elseResult.dataType.nullable;
    } else {
      // No ELSE means result can be null
      nullable = true;
    }

    return { ...node, dataType: dataType(resultType, nullable) };
  }

  private inferFunction(node: Expr & { kind: "FunctionCall" }): Expr {
    const sig = this.functions.get(node.name);
    if (!sig) {
      this.errors.push({
        loc: node.loc,
        code: "UNKNOWN_FUNCTION",
        message: `Unknown function '${node.name}'`,
      });
      return { ...node, dataType: dataType("unknown", true) };
    }
    if (node.args.length < sig.minArgs || node.args.length > sig.maxArgs) {
      this.errors.push({
        loc: node.loc,
        code: "ARG_COUNT",
        message: `${node.name} expects ${sig.minArgs === sig.maxArgs ? sig.minArgs : `${sig.minArgs}-${sig.maxArgs}`} arguments, got ${node.args.length}`,
      });
    }
    const argTypes = node.args
      .map((a) => a.dataType)
      .filter((t): t is DataType => t !== undefined);
    const resolved = sig.resolve(argTypes);
    return { ...node, dataType: resolved };
  }

  private inferAggregate(node: Expr & { kind: "AggregateCall" }): Expr {
    const argType =
      node.args.length > 0 && node.args[0].kind !== "Star"
        ? node.args[0].dataType ?? null
        : null;
    const dt = aggregateReturnType(node.name, argType);
    return { ...node, dataType: dt };
  }
}
