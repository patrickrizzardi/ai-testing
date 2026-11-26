import { earliestError, fail, succeed, syntaxErrorAt, type Result, type RippleError, type SourcePosition } from "../errors";
import { BUILTIN_NAMES } from "../language/builtin-names";
import type { Block, Expression, FunctionDeclaration, Identifier, Program, Statement } from "../syntax/ast";
import type { IdentifierToken } from "../syntax/tokens";
import { visitExpression } from "../syntax/walk";
import type { Declaration, DeclarationKind, DeclarationSite, Resolution, ScopeInfo, ScopeOwner } from "./model";

/** Scopes, declarations and resolutions of a program (spec section 4.1). */
export type ResolvedProgram = {
  readonly builtinScope: ScopeInfo;
  readonly scopeInfos: ReadonlyMap<ScopeOwner, ScopeInfo>;
  readonly resolutions: ReadonlyMap<Identifier, Resolution | null>;
  readonly declarations: ReadonlyMap<DeclarationSite, Declaration>;
};

type ScopeBuilder = {
  readonly parent: ScopeBuilder | null;
  readonly owner: FunctionDeclaration | null;
  readonly names: Map<string, Declaration>;
  readonly declarations: Declaration[];
  readonly hoisted: Declaration[];
  readonly info: ScopeInfo;
};

type LeadingDeclaration = { readonly token: IdentifierToken; readonly site: DeclarationSite | null };

function isValidAssignmentTarget(target: Expression): boolean {
  return target.kind === "Identifier" || target.kind === "Index" || target.kind === "Field";
}

class Resolver {
  private readonly errors: RippleError[] = [];
  private readonly scopeInfos = new Map<ScopeOwner, ScopeInfo>();
  private readonly resolutions = new Map<Identifier, Resolution | null>();
  private readonly declarations = new Map<DeclarationSite, Declaration>();
  private readonly builtinScope: ScopeBuilder;
  private scope: ScopeBuilder;
  private currentFunction: FunctionDeclaration | null = null;

  constructor() {
    this.builtinScope = this.createScope(null, null);
    for (const name of BUILTIN_NAMES) this.addDeclaration(this.builtinScope, name, "builtin", null);
    this.scope = this.builtinScope;
  }

  resolve(program: Program): Result<ResolvedProgram> {
    this.enterScope(program, [], program.statements);
    this.resolveStatements(program.statements);
    this.leaveScope();
    const [first, ...rest] = this.errors;
    if (first !== undefined) return fail(earliestError([first, ...rest]));
    return succeed({ builtinScope: this.builtinScope.info, scopeInfos: this.scopeInfos, resolutions: this.resolutions, declarations: this.declarations });
  }

  private createScope(parent: ScopeBuilder | null, owner: FunctionDeclaration | null): ScopeBuilder {
    const declarations: Declaration[] = [];
    const hoisted: Declaration[] = [];
    return { parent, owner, names: new Map(), declarations, hoisted, info: { declarations, hoisted } };
  }

  private addDeclaration(scope: ScopeBuilder, name: string, kind: DeclarationKind, declaredFunction: FunctionDeclaration | null): Declaration {
    const declaration: Declaration = { name, kind, slot: scope.declarations.length, owner: scope.owner, declaredFunction };
    scope.names.set(name, declaration);
    scope.declarations.push(declaration);
    if (kind === "fn") scope.hoisted.push(declaration);
    return declaration;
  }

  /** Declares `name` in `scope`; a second declaration of a name is an error at its token and maps to the first. */
  private declare(scope: ScopeBuilder, token: IdentifierToken, kind: DeclarationKind, declaredFunction: FunctionDeclaration | null, site: DeclarationSite | null): void {
    const existing = scope.names.get(token.text);
    if (existing !== undefined) this.report(token, `'${token.text}' is already declared in this scope`);
    const declaration = existing ?? this.addDeclaration(scope, token.text, kind, declaredFunction);
    if (site !== null) this.declarations.set(site, declaration);
  }

  private report(position: SourcePosition, message: string): void {
    this.errors.push(syntaxErrorAt(position, message));
  }

  /** Opens the scope of `owner`: `leading` names first (parameters, loop variable), then the statements' own `let` and `fn` names (declared functions). */
  private enterScope(owner: ScopeOwner, leading: readonly LeadingDeclaration[], statements: readonly Statement[]): void {
    const enclosingFunction = owner.kind === "Function" ? owner : this.currentFunction;
    const scope = this.createScope(this.scope, enclosingFunction);
    this.currentFunction = enclosingFunction;
    for (const { token, site } of leading) this.declare(scope, token, "variable", null, site);
    for (const statement of statements) {
      if (statement.kind === "Let") this.declare(scope, statement.nameToken, "variable", null, statement);
      else if (statement.kind === "Function") this.declare(scope, statement.nameToken, "fn", statement, statement);
    }
    this.scopeInfos.set(owner, scope.info);
    this.scope = scope;
  }

  private leaveScope(): void {
    const parent = this.scope.parent;
    if (parent === null) throw new Error("cannot leave the builtin scope");
    this.scope = parent;
  }

  private resolveStatements(statements: readonly Statement[]): void {
    for (const statement of statements) this.resolveStatement(statement);
  }

  private resolveBlock(block: Block, leading: readonly LeadingDeclaration[]): void {
    this.enterScope(block, leading, block.statements);
    this.resolveStatements(block.statements);
    this.leaveScope();
  }

  private resolveStatement(statement: Statement): void {
    switch (statement.kind) {
      case "Let":
        this.resolveExpression(statement.initializer);
        return;
      case "Expression":
        this.resolveExpression(statement.expression);
        return;
      case "Assign":
        this.resolveAssignment(statement.target, statement.equals, statement.value);
        return;
      case "If":
        this.resolveExpression(statement.condition);
        this.resolveBlock(statement.thenBlock, []);
        if (statement.elseBranch?.kind === "Block") this.resolveBlock(statement.elseBranch, []);
        else if (statement.elseBranch !== null) this.resolveStatement(statement.elseBranch);
        return;
      case "While":
        this.resolveExpression(statement.condition);
        this.resolveBlock(statement.body, []);
        return;
      case "For":
        this.resolveExpression(statement.iterable);
        this.resolveBlock(statement.body, [{ token: statement.variableToken, site: statement }]);
        return;
      case "Function": {
        const enclosingFunction = this.currentFunction;
        this.enterScope(
          statement,
          statement.parameters.map((token) => ({ token, site: null })),
          statement.body.statements,
        );
        this.resolveStatements(statement.body.statements);
        this.leaveScope();
        this.currentFunction = enclosingFunction;
        return;
      }
      case "Return":
        if (this.currentFunction === null) this.report(statement.keyword, "'return' outside a function");
        if (statement.value !== null) this.resolveExpression(statement.value);
        return;
    }
  }

  private resolveAssignment(target: Expression, equals: SourcePosition, value: Expression): void {
    if (!isValidAssignmentTarget(target)) this.report(equals, "the left side of '=' is not assignable");
    this.resolveExpression(target);
    this.resolveExpression(value);
    if (target.kind !== "Identifier") return;
    const kind = this.resolutions.get(target)?.declaration.kind;
    if (kind === "fn" || kind === "builtin") this.report(target.token, `cannot assign to ${kind === "fn" ? "function" : "builtin"} '${target.name}'`);
  }

  private resolveExpression(expression: Expression): void {
    visitExpression(expression, (visited) => {
      if (visited.kind === "Identifier") this.resolveIdentifier(visited);
      else if (visited.kind === "RecordLiteral") this.checkRecordFields(visited.fields);
    });
  }

  private checkRecordFields(fields: readonly { readonly name: string; readonly nameToken: IdentifierToken }[]): void {
    const seen = new Set<string>();
    for (const field of fields) {
      if (seen.has(field.name)) this.report(field.nameToken, `record field '${field.name}' is repeated`);
      seen.add(field.name);
    }
  }

  private resolveIdentifier(identifier: Identifier): void {
    let hops = 0;
    for (let scope: ScopeBuilder | null = this.scope; scope !== null; scope = scope.parent) {
      const declaration = scope.names.get(identifier.name);
      if (declaration !== undefined) {
        this.resolutions.set(identifier, { declaration, hops });
        return;
      }
      hops += 1;
    }
    this.resolutions.set(identifier, null);
  }
}

/** Builds scopes and resolves every identifier; reports the earliest static error of spec 4.2. O(n) time and memory. */
export function resolveProgram(program: Program): Result<ResolvedProgram> {
  return new Resolver().resolve(program);
}
