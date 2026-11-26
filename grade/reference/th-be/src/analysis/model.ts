import type { Block, Call, ExpressionStatement, ForStatement, FunctionDeclaration, Identifier, LetStatement, Program, Statement } from "../syntax/ast";

export type DeclarationKind = "builtin" | "fn" | "variable";

export type Declaration = {
  readonly name: string;
  readonly kind: DeclarationKind;
  /** Index of the declaration's cell in a runtime scope made from the `ScopeInfo` that lists it. */
  readonly slot: number;
  /** The function whose own scopes make this declaration; null for the program scope and the builtins. */
  readonly owner: FunctionDeclaration | null;
  /** The declared function when `kind` is "fn". */
  readonly declaredFunction: FunctionDeclaration | null;
};

/** Static shape of one scope: what it declares and which functions are bound when it is entered. */
export type ScopeInfo = {
  readonly declarations: readonly Declaration[];
  /** Declarations of `fn` statements directly in the scope, in source order. */
  readonly hoisted: readonly Declaration[];
};

/** What an identifier occurrence refers to, and how many scope links up the declaring scope is. */
export type Resolution = { readonly declaration: Declaration; readonly hops: number };

/** The nodes that open a scope: the program, a function (parameters and body share it) or an if/else/while/for body. */
export type ScopeOwner = Program | FunctionDeclaration | Block;

/** The nodes that declare a name the evaluator has to find again. */
export type DeclarationSite = LetStatement | FunctionDeclaration | ForStatement;

/** A candidate statement of a concurrent run (spec 9.1): `f(args);` or `let x = f(args);`. */
export type RunMember = {
  readonly statement: LetStatement | ExpressionStatement;
  readonly call: Call;
  /** The variable a `let` member initializes; null for a bare call. */
  readonly binding: Declaration | null;
};

/** How the evaluator executes part of a statement list. */
export type Step =
  | { readonly kind: "single"; readonly statement: Statement }
  /** Two or more independent candidates: executed by section 9.3. */
  | { readonly kind: "concurrentRun"; readonly members: readonly RunMember[] };

/** Everything computed from the program text before it runs. */
export type Analysis = {
  readonly builtinScope: ScopeInfo;
  scopeOf(owner: ScopeOwner): ScopeInfo;
  /** Null when the name is unresolved. */
  resolutionOf(identifier: Identifier): Resolution | null;
  declarationOf(site: DeclarationSite): Declaration;
  stepsOf(statementList: Program | Block): readonly Step[];
};
