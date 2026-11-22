import argparse
import re
import shutil
from pathlib import Path


HERE = Path(__file__).resolve().parent
FUNCTIONS = HERE.parents[1] / "supabase" / "functions"


def export_handler(source):
    if not source.rstrip().endswith("});"):
        raise ValueError("The existing webhook handler has changed.")
    source = re.sub(r"^Deno\.serve\(async\s*\(?request\)?\s*=>\s*\{", "export async function handler(request: Request) {", source, flags=re.M)
    return source.rstrip()[:-3] + "}\n"


def dolly(source):
    source = re.sub(r"^import \{ createClient \} from [^\n]+\n", 'import { env, service, outputText } from "./bridge.ts";\n', source, flags=re.M)
    source = re.sub(r"^const service = createClient[^\n]+\n", "", source, flags=re.M)
    source = source.replace("Deno.env.get(", "env(").replace("in den Supabase-Secrets", "in der Vorschau-Konfiguration")
    source = source.replace("data.output_text", "outputText(data)")
    source = source.replace('async function sendScheduledDailySummary()', 'export async function sendScheduledDailySummary()')
    source = re.sub(r'^  if \(requestUrl\.searchParams\.get\("scheduled"\) === "daily-summary"\) \{.*?^  }\n', "", source, flags=re.M | re.S)
    source = re.sub(r'^  const requestUrl = new URL\(request.url\);\n', "", source, flags=re.M)
    source = re.sub(r'^    service\.from\("(?:paypal_transactions|download_events)"\)[^\n]+\n', "", source, flags=re.M)
    source = source.replace("{ count: orders }, ", "").replace("{ count: downloads }, { data: orders }, ", "")
    source = re.sub(r'^    `🛒 Erfolgreiche Bestellungen heute:[^\n]+\n', "", source, flags=re.M)
    source = re.sub(r'^  const revenue = [^\n]+\n', "", source, flags=re.M)
    source = re.sub(r', `🛒 Bestellungen:[^\n]+?`📥 Geöffnete Downloads:[^`]+`', "", source)
    source = re.sub(r'^async function orderSummaryText\(\) \{.*?^}', 'async function orderSummaryText() {\n'
                    '  return "PayPal-Bestellungen und Downloads stehen in der Live-Verwaltung.";\n}', source, flags=re.M | re.S)
    source = source.replace('https://esm.sh/pdf-lib@1.17.1?target=deno', 'npm:pdf-lib@1.17.1')
    return export_handler(source)


def instagram(source):
    return 'import { env } from "./bridge.ts";\n' + export_handler(source.replace("Deno.env.get(", "env("))


def build(destination):
    destination.mkdir(parents=True, exist_ok=True)
    for name in ("bridge.ts", "worker.ts"):
        shutil.copyfile(HERE / name, destination / name)
    for name, directory, adapt in (("dolly", "dolly-telegram", dolly), ("instagram", "instagram-link-bot", instagram)):
        source = (FUNCTIONS / directory / "index.ts").read_text(encoding="utf-8")
        (destination / f"{name}.ts").write_text(adapt(source), encoding="utf-8")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Build staging bot webhooks from the live source and a PocketBase adapter.")
    parser.add_argument("destination", type=Path)
    build(parser.parse_args().destination)
