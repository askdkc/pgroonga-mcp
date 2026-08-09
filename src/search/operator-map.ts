import type { SearchMode } from "./types.js";

export type SearchOperator = "&@" | "&@~" | "&^" | "&=" | "&~" | "&@*";

const modeOperators: Record<SearchMode, SearchOperator> = {
  keyword: "&@",
  query: "&@~",
  prefix: "&^",
  exact: "&=",
  regexp: "&~",
  similar: "&@*",
};

export function operatorForMode(mode: SearchMode): SearchOperator {
  return modeOperators[mode];
}

export function supportedModesForOperatorClass(operatorClass: string): SearchMode[] {
  const name = operatorClass.toLowerCase();
  const modes = new Set<SearchMode>();
  if (name.includes("semantic_search")) modes.add("similar");
  if (name.includes("full_text_search")) {
    modes.add("keyword");
    modes.add("query");
  }
  if (name.includes("term_search")) {
    modes.add("prefix");
    modes.add("exact");
  }
  if (name.includes("regexp")) modes.add("regexp");
  return [...modes];
}

export function isSupportedMode(operatorClass: string, mode: SearchMode): boolean {
  return supportedModesForOperatorClass(operatorClass).includes(mode);
}
