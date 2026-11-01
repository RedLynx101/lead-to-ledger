# Lead to Ledger

A lead goes from a web form to a QuickBooks invoice. An n8n workflow sorts what plain rules can. A classifier handles the rest against a strict schema and may write only to `ai_` fields in HubSpot. It is scored on labeled synthetic leads and runs in shadow mode before it can write anything. When a deal is won and a person approves it, a worker creates the customer and invoice, and restart tests kill that worker before, during and after each API call and count duplicates.

Built with AI coding agents under Noah Hicks's review. No client deployment yet.

## Status

Work in progress. What exists today:

- HubSpot and QuickBooks simulators written from the vendors' docs, with failure injection: timeouts, responses lost after the write committed, 429 and 5xx, and expired tokens. `docs/simulator-sources.md` records where each behaviour comes from. None of it has been checked against the real services yet.
- A seeded generator of labeled synthetic leads for a fictional HVAC contractor, with a held-out test set written separately from the prompt and rules. All names, addresses and phone numbers are made up, on domains and number blocks reserved for documentation.

Not built yet: the lead path, the invoice path, the restart tests, and the real run.

## Run it

Needs Node 24. Docker is optional for now.

```sh
npm install
npm test            # simulator and generator tests
npm run sim         # starts the simulators on localhost:4010 and :4020
npm run gen:leads   # regenerates data/leads from the seed
```

Or `docker compose up --build`, which also starts Postgres. Everything binds to `127.0.0.1`.

## License

MIT. See `LICENSE`.
