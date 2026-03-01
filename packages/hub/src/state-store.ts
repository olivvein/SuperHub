import fastJsonPatch from "fast-json-patch";

export interface JsonPatchOp {
  op: "add" | "remove" | "replace" | "move" | "copy" | "test";
  path: string;
  from?: string;
  value?: unknown;
}

export interface StateMutation {
  path: string;
  value: unknown;
}

export class StateStore {
  private readonly state = new Map<string, unknown>();

  set(path: string, value: unknown): StateMutation {
    this.state.set(normalizePath(path), clone(value));
    return {
      path: normalizePath(path),
      value: clone(value)
    };
  }

  get<TValue = unknown>(path: string): TValue | null {
    const normalized = normalizePath(path);
    if (!this.state.has(normalized)) {
      return null;
    }

    return clone(this.state.get(normalized)) as TValue;
  }

  patch(path: string, patch: JsonPatchOp[]): StateMutation {
    const normalized = normalizePath(path);
    const current = this.state.get(normalized);
    const initial = current === undefined ? {} : clone(current);
    const next = fastJsonPatch.applyPatch(initial as object, patch as never[], true, false).newDocument;
    this.state.set(normalized, next);
    return {
      path: normalized,
      value: clone(next)
    };
  }

  loadSnapshots(entries: Array<{ path: string; value: unknown }>): void {
    for (const entry of entries) {
      this.state.set(normalizePath(entry.path), clone(entry.value));
    }
  }

  list(prefix?: string): Array<{ path: string; value: unknown }> {
    const normalizedPrefix = prefix ? normalizePath(prefix) : null;
    const output: Array<{ path: string; value: unknown }> = [];

    for (const [path, value] of this.state.entries()) {
      if (normalizedPrefix && !path.startsWith(normalizedPrefix)) {
        continue;
      }
      output.push({ path, value: clone(value) });
    }

    return output.sort((a, b) => a.path.localeCompare(b.path));
  }
}

function normalizePath(path: string): string {
  if (!path.startsWith("state/")) {
    return `state/${path.replace(/^\/+/, "")}`;
  }
  return path;
}

function clone<T>(value: T): T {
  if (value === undefined) {
    return value;
  }
  return JSON.parse(JSON.stringify(value)) as T;
}
