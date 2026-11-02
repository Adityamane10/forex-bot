/** Minimal query DSL shared by the memory and mongo store backends. */

export type QueryValue = string | number | boolean | Date | null;
export type QueryFilter = {
  [field: string]: QueryValue | { $gt?: QueryValue; $gte?: QueryValue; $lt?: QueryValue; $lte?: QueryValue; $ne?: QueryValue; $in?: QueryValue[]; $exists?: boolean } | QueryFilter;
};

export type SortSpec = { [field: string]: 1 | -1 };

export interface UpdateDoc {
  $set?: Record<string, unknown>;
  $inc?: Record<string, number>;
  $push?: Record<string, unknown>;
  $unset?: Record<string, unknown>;
}

function matchesValue(value: unknown, op: Record<string, unknown>): boolean {
  for (const [k, v] of Object.entries(op)) {
    switch (k) {
      case '$gt':
        if (!(typeof value === 'number' && value > (v as number))) return false;
        break;
      case '$gte':
        if (!(typeof value === 'number' && value >= (v as number))) return false;
        break;
      case '$lt':
        if (!(typeof value === 'number' && value < (v as number))) return false;
        break;
      case '$lte':
        if (!(typeof value === 'number' && value <= (v as number))) return false;
        break;
      case '$ne':
        if (value === v) return false;
        break;
      case '$in':
        if (!Array.isArray(v) || !v.includes(value)) return false;
        break;
      case '$exists':
        if (v && (value === undefined || value === null)) return false;
        if (!v && value !== undefined && value !== null) return false;
        break;
      default:
        return false;
    }
  }
  return true;
}

export function matchesFilter<T extends Record<string, unknown>>(doc: T, filter: QueryFilter): boolean {
  for (const [field, cond] of Object.entries(filter)) {
    if (cond === null || typeof cond !== 'object' || Array.isArray(cond)) {
      if (doc[field] !== cond) return false;
      continue;
    }
    const isOperator = Object.keys(cond).every((k) => k.startsWith('$'));
    if (isOperator) {
      if (!matchesValue(doc[field], cond as Record<string, unknown>)) return false;
    } else {
      // nested object filter (only supports dotted field strings in practice)
      const nested = doc[field] as Record<string, unknown> | undefined;
      if (!nested || !matchesFilter(nested as Record<string, unknown>, cond as QueryFilter)) return false;
    }
  }
  return true;
}

export function applySort<T>(docs: T[], sort?: SortSpec): T[] {
  if (!sort) return docs;
  const keys = Object.keys(sort);
  return [...docs].sort((a, b) => {
    for (const k of keys) {
      const av = (a as Record<string, unknown>)[k];
      const bv = (b as Record<string, unknown>)[k];
      const dir = sort[k];
      if (av === bv) continue;
      if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * dir;
      return String(av).localeCompare(String(bv)) * dir;
    }
    return 0;
  });
}

export function applyUpdate<T extends Record<string, unknown>>(doc: T, update: UpdateDoc): T {
  const d = doc as Record<string, unknown>;
  if (update.$set) {
    for (const [k, v] of Object.entries(update.$set)) d[k] = v;
  }
  if (update.$inc) {
    for (const [k, v] of Object.entries(update.$inc)) {
      const cur = (d[k] as number) || 0;
      d[k] = cur + (v as number);
    }
  }
  if (update.$push) {
    for (const [k, v] of Object.entries(update.$push)) {
      const arr = (d[k] as unknown[]) || [];
      arr.push(v);
      d[k] = arr;
    }
  }
  if (update.$unset) {
    for (const k of Object.keys(update.$unset)) delete d[k];
  }
  return doc;
}
