import { describe, expect, it } from "vitest";

import {
  parseNormalizationProfile,
  parseNormalizerChain,
  parseTableReference,
  replaceTableReferences,
} from "../../src/normalization/profile-parser.js";

describe("normalization profile parser", () => {
  it("preserves normalizer order and parses options", () => {
    const chain = parseNormalizerChain(
      'NormalizerNFKC("version", "15.0.0", "unify_iteration_mark", true), NormalizerTable("normalized", "${table:public.synonyms_index}.normalized", "target", "target")',
    );
    expect(chain.map((item) => item.name)).toEqual(["NormalizerNFKC", "NormalizerTable"]);
    expect(chain[0]?.options).toMatchObject({ version: "15.0.0", unify_iteration_mark: true });
    expect(chain[1]?.options).toMatchObject({
      normalized: "${table:public.synonyms_index}.normalized",
      target: "target",
    });
  });

  it("discovers dictionary dependencies and highlight compatibility", () => {
    const profile = parseNormalizationProfile("public.search_index", [
      'tokenizer=TokenNgram("report_source_location", true)',
      'normalizers=NormalizerNFKC("report_source_offset", true), NormalizerTable("normalized", "${table:public.synonyms_index}.normalized", "target", "target", "report_source_offset", true)',
    ]);
    expect(profile?.dictionaryDependencies).toEqual([
      {
        dictionaryIndex: "public.synonyms_index",
        dictionaryColumn: "normalized",
        targetColumn: "target",
        normalizedColumn: "normalized",
      },
    ]);
    expect(profile?.highlightCompatible).toBe(true);
  });

  it("parses and safely replaces only trusted table placeholders", () => {
    expect(parseTableReference("${table:public.synonyms_index}.normalized")).toEqual({
      index: "public.synonyms_index",
      column: "normalized",
    });
    expect(
      replaceTableReferences(
        'NormalizerTable("${table:public.synonyms_index}.normalized")',
        new Map([["public.synonyms_index", "Lexicon123"]]),
      ),
    ).toBe('NormalizerTable("Lexicon123.normalized")');
  });

  it("parses per-column normalizers_mapping without reordering it", () => {
    const profile = parseNormalizationProfile("public.search_index", [
      'normalizers_mapping={"title":"NormalizerNFKC(\\"unify_kana\\", true)"}',
    ]);
    expect(profile?.normalizersMapping.title?.normalizerChain[0]?.name).toBe("NormalizerNFKC");
    expect(profile?.normalizerChain).toEqual([]);
  });
});
