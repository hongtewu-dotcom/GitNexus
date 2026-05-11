import type Parser from 'tree-sitter';

export type ThriftRole = 'provider' | 'consumer';

export interface ThriftDetection {
  role: ThriftRole;
  serviceName: string;
  methodName: string;
  symbolName: string;
  source: string;
  confidenceWithIdl: number;
  confidenceWithoutIdl: number;
  usesGeneratedServiceMember?: boolean;
  /** The enclosing method that makes this thrift call (for scope filtering). */
  callerMethod?: string;
}

export interface ThriftLanguagePlugin {
  name: string;
  language: unknown;
  scan(tree: Parser.Tree): ThriftDetection[];
}
