type Input = { table: string; count?: boolean; from?: string; before?: string; marker?: string; insert?: boolean; limit?: number };
type Result = { data?: any[]; count?: number; error?: Error };

export const env = (name: string) => Deno.env.get(`FINDORA_STAGING_${name}`);

export function outputText(payload: { output_text?: string; output?: { content?: { type: string; text?: string }[] }[] }) {
  return payload.output_text || (payload.output ?? []).flatMap(item => item.content ?? [])
    .filter(item => item.type === "output_text").map(item => item.text ?? "").join("\n");
}

async function query(input: Input): Promise<Result> {
  const key = env("WORKER_KEY");
  if (!key) throw new Error("PocketBase ist für Dolly noch nicht eingerichtet.");
  const response = await fetch("http://127.0.0.1:8090/api/findora/internal/staging-worker", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Findora-Worker-Key": key },
    body: JSON.stringify(input), signal: AbortSignal.timeout(8000),
  });
  if (!response.ok) throw new Error("Dolly konnte die Vorschau-Daten nicht laden.");
  return await response.json();
}

class FindoraQuery implements PromiseLike<Result> {
  readonly input: Input;
  constructor(table: string) { this.input = { table }; }
  select(_columns: string, options?: { head?: boolean }) { this.input.count = options?.head === true; return this; }
  eq(field: string, value: unknown) {
    if (field === "event_type" && typeof value === "string") this.input.marker = value;
    return this;
  }
  gte(_field: string, date: string) { this.input.from = date; return this; }
  lt(_field: string, date: string) { this.input.before = date; return this; }
  order(_field: string, _options: { ascending: boolean }) { return this; } // PocketBase applies each collection's existing order.
  limit(rows: number) { this.input.limit = rows; return this; }
  insert(value: { event_type: string }) { this.input.marker = value.event_type; this.input.insert = true; return this; }
  then<T, U>(resolve: ((value: Result) => T | PromiseLike<T>) | null, reject?: ((error: unknown) => U | PromiseLike<U>) | null) {
    return query(this.input).then(resolve, reject);
  }
}

export const service = { from: (table: string) => new FindoraQuery(table) };
