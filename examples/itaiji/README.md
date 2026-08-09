# 異体字 fixture

Run `schema.sql` in a database with PGroonga and Groonga support for the `unify_iteration_mark` option. Then configure the server with `PGROONGA_ALLOWED_SCHEMAS=public` and use:

```json
{
  "index": "public.itaiji_biblios_title_index",
  "text": "笔衟"
}
```

`pgroonga_normalize_text` should return `筆道`. The search profile uses the dictionary only for variant canonicalization and uses the built-in NFKC option independently for `かゝみ -> かかみ`.

If the dictionary changes, reindex `public.itaiji_biblios_title_index`; the server reports dictionary freshness as unknown and never performs the reindex.
