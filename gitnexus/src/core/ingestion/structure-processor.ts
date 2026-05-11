import { generateId } from '../../lib/utils.js';
import type { GraphNode } from 'gitnexus-shared';
import { KnowledgeGraph } from '../graph/types.js';

export const processStructure = (graph: KnowledgeGraph, paths: string[]) => {
  paths.forEach((path) => {
    const nodeId = generateId('File', path);
    const name = path.split('/').pop() || path;

    const node: GraphNode = {
      id: nodeId,
      label: 'File',
      properties: {
        name,
        filePath: path,
      },
    };
    graph.addNode(node);
  });
};
