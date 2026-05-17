# Yahoo Affiliate Staging Notes

Yahoo affiliate support is controlled at build time.

## Environment

Production keeps Yahoo display off:

```env
PUBLIC_ENABLE_YAHOO_AFFILIATE=false
PUBLIC_NOINDEX=false
```

Staging / preview can enable Yahoo display and must be noindex:

```env
PUBLIC_ENABLE_YAHOO_AFFILIATE=true
PUBLIC_NOINDEX=true
YAHOO_SHOPPING_APP_ID=...
VALUECOMMERCE_SID=...
VALUECOMMERCE_PID=...
```

Do not add Yahoo credentials to the production Rakuten cron.

## Dry Run

```bash
pnpm update-yahoo-products:dry
pnpm update-yahoo-products -- --dry-run --article=toilet-paper-comparison --limit=1
```

Dry-run writes a report under `reports/` and does not edit article files. If credentials are missing, the report records that Yahoo sync was skipped.

## Limited Write

```bash
pnpm update-yahoo-products -- --write --article=toilet-paper-comparison --api-interval=1000
```

Writes should be run only on staging and only for explicitly selected articles. Existing `rakutenUrl` values are preserved.
