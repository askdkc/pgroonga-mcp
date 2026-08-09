-- Compact, reviewable fixture. The dictionary is intentionally not the full
-- Kokubunken dataset; its mappings are domain policy, not universal truth.
CREATE TABLE public.itaiji_synonyms (
  target text NOT NULL,
  normalized text NOT NULL
);

CREATE INDEX public.itaiji_synonyms_index
  ON public.itaiji_synonyms
  USING pgroonga (
    target pgroonga_text_term_search_ops_v2,
    normalized
  );

INSERT INTO public.itaiji_synonyms (target, normalized) VALUES
  ('笔', '筆'),
  ('衜', '道'),
  ('衟', '道'),
  ('噵', '道');

CREATE TABLE public.itaiji_biblios (
  id bigint PRIMARY KEY,
  title text NOT NULL
);

CREATE INDEX public.itaiji_biblios_title_index
  ON public.itaiji_biblios
  USING pgroonga (title)
  WITH (
    tokenizer = 'TokenNgram("report_source_location", true)',
    normalizers = 'NormalizerNFKC("version", "15.0.0", "unify_iteration_mark", true, "report_source_offset", true), NormalizerTable("normalized", "${table:public.itaiji_synonyms_index}.normalized", "target", "target", "report_source_offset", true)'
  );

INSERT INTO public.itaiji_biblios (id, title) VALUES
  (1, '筆道'),
  (2, '笔道'),
  (3, '筆衜'),
  (4, '笔衟'),
  (5, '笔噵'),
  (6, 'かかみ');

-- The built-in normalizer handles this independently of the dictionary.
-- Expected: pgroonga_normalize('かゝみ', 'NormalizerNFKC("unify_iteration_mark", true)') = 'かかみ'
