export type BankSourceFact = {
  id: string; ledgerAccountId: string; bankIdentityHash: string; currency: string;
  externalId: string | null; correctsExternalId: string | null; correctionAction: string | null;
};
export type BankSourceState = "ACTIVE" | "SUPERSEDED" | "REMOVED" | "UNRESOLVED" | "AMBIGUOUS";
const externalKey = (fact: BankSourceFact, externalId: string) => JSON.stringify([fact.ledgerAccountId, fact.bankIdentityHash, externalId]);

/** All retained versions of one actual bank movement share its allocation admission boundary. */
export function bankStatementSourceFamilyMembers(facts: readonly BankSourceFact[]): ReadonlyMap<string, readonly string[]> {
  const external = new Map(facts.flatMap(fact => fact.externalId ? [[externalKey(fact, fact.externalId), fact.id] as const] : []));
  const parent = new Map(facts.map(fact => [fact.id, fact.id]));
  const root = (id: string) => { let current = id; const path: string[] = []; while (parent.get(current) !== current) { path.push(current); current = parent.get(current)!; } for (const member of path) parent.set(member, current); return current; };
  for (const fact of facts) {
    const original = fact.correctsExternalId ? external.get(externalKey(fact, fact.correctsExternalId)) : undefined;
    if (original) parent.set(root(fact.id), root(original));
  }
  const groups = new Map<string, string[]>();
  for (const fact of facts) { const identity = root(fact.id), group = groups.get(identity) ?? []; group.push(fact.id); groups.set(identity, group); }
  for (const group of groups.values()) group.sort();
  return new Map(facts.map(fact => [fact.id, groups.get(root(fact.id))!]));
}

/** The adapter supplies complete correction families, including ancestors and competing children. */
export function bankStatementSourceStates(facts: readonly BankSourceFact[]): ReadonlyMap<string, BankSourceState> {
  const ids = new Set<string>(), external = new Map<string, BankSourceFact>(), children = new Map<string, BankSourceFact[]>();
  const key = externalKey;
  for (const fact of facts) {
    if (!fact.id || ids.has(fact.id) || !/^[A-Z]{3}$/u.test(fact.currency) ||
        (!!fact.correctsExternalId !== !!fact.correctionAction) ||
        fact.correctionAction && !["REPLACE", "DELETE"].includes(fact.correctionAction)) throw new Error("invalid_bank_correction_family");
    ids.add(fact.id);
    if (fact.externalId) {
      const identity = key(fact, fact.externalId);
      if (external.has(identity)) throw new Error("duplicate_original_bank_identity");
      external.set(identity, fact);
    }
    if (fact.correctsExternalId) {
      const parent = key(fact, fact.correctsExternalId), siblings = children.get(parent) ?? [];
      siblings.push(fact); children.set(parent, siblings);
    }
  }
  const states = new Map<string, BankSourceState>();
  for (const fact of facts) {
    const visited = new Set<string>(); let ancestor = fact, invalid: BankSourceState | null = null;
    while (true) {
      if (visited.has(ancestor.id)) { invalid = "AMBIGUOUS"; break; }
      visited.add(ancestor.id);
      if (ancestor.externalId && (children.get(key(ancestor, ancestor.externalId))?.length ?? 0) > 1) { invalid = "AMBIGUOUS"; break; }
      if (!ancestor.correctsExternalId) break;
      const parent = external.get(key(ancestor, ancestor.correctsExternalId));
      if (!parent) { invalid = "UNRESOLVED"; break; }
      if (parent.currency !== fact.currency || parent.correctionAction === "DELETE") { invalid = "AMBIGUOUS"; break; }
      ancestor = parent;
    }
    states.set(fact.id, invalid ?? (fact.externalId && children.has(key(fact, fact.externalId)) ? "SUPERSEDED" : fact.correctionAction === "DELETE" ? "REMOVED" : "ACTIVE"));
  }
  return states;
}
