# Findora Home Instagram-Link-Bot

Webhook-Adresse:

`https://wcpifcdwomjzmvnvgqwr.supabase.co/functions/v1/instagram-link-bot`

Der Bot reagiert in Kommentaren unter den verbundenen Instagram-Beiträgen auf das einzelne Wort `Link` (Groß-/Kleinschreibung egal) und schickt den Findora-Home-Link als private Antwort.

## Benötigte Supabase-Secrets

- `INSTAGRAM_WEBHOOK_VERIFY_TOKEN`: ein selbst gewähltes langes Kennwort
- `INSTAGRAM_APP_SECRET`: App Secret der Meta-App
- `INSTAGRAM_ACCESS_TOKEN`: langlebiges Zugriffstoken des Instagram-Kontos
- `INSTAGRAM_USER_ID`: Instagram Professional Account ID
- optional `INSTAGRAM_REPLY_URL`: Ziel-Link
- optional `INSTAGRAM_REPLY_TEXT`: vollständiger Nachrichtentext

## Meta-Einrichtung

1. In Meta for Developers eine Business-App mit Instagram hinzufügen.
2. Das professionelle Instagram-Konto verbinden.
3. Die Webhook-Adresse oben und denselben Verify Token aus Supabase eintragen.
4. Das Webhook-Feld `comments` abonnieren.
5. Die benötigten Berechtigungen für Kommentare und Nachrichten freigeben lassen.
6. Die App in den Live-Modus stellen und mit einem Testkommentar `Link` prüfen.

Meta verlangt für öffentliche Nutzung die passenden Berechtigungen beziehungsweise Advanced Access und gegebenenfalls eine App-Prüfung.
