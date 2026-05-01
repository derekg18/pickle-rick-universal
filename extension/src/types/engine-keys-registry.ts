export interface EngineKeysRegistry {
  schema_version: number;
  engine_keys: string[];
  engine_key_patterns: string[];
  user_written_patterns: string[];
}
