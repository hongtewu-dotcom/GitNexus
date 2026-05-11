export interface FTSIndexDefinition {
  readonly table: string;
  readonly indexName: string;
  readonly properties: readonly string[];
}

export const FTS_INDEXES: readonly FTSIndexDefinition[] = [
  // FTS disabled — impact/context don't need full-text search.
  // query tool falls back to exact match when no FTS indexes exist.
];
