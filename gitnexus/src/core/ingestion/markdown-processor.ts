/**
 * Markdown Processor
 *
 * Extracts cross-file IMPORTS links from .md files using regex.
 * (Section node generation removed — never queried by any MCP tool.)
 */

import path from 'node:path';
import { generateId } from '../../lib/utils.js';
import { KnowledgeGraph } from '../graph/types.js';
const LINK_RE = /\[([^\]]*)\]\(([^)]+)\)/g;
const MD_EXTENSIONS = new Set(['.md', '.mdx']);

interface MdFile {
  path: string;
  content: string;
}

export const processMarkdown = (
  graph: KnowledgeGraph,
  files: MdFile[],
  allPathSet: ReadonlySet<string>,
): { sections: number; links: number } => {
  const totalSections = 0;
  let totalLinks = 0;

  for (const file of files) {
    const ext = path.extname(file.path).toLowerCase();
    if (!MD_EXTENSIONS.has(ext)) continue;

    const fileNodeId = generateId('File', file.path);
    // Skip if file node doesn't exist (shouldn't happen, structure-processor creates it)
    if (!graph.getNode(fileNodeId)) continue;

    // NOTE: Section node generation removed — never queried by any MCP tool.
    // Only cross-file IMPORTS links are preserved below.

    // --- Extract links to other files in the repo ---
    const fileDir = path.dirname(file.path);
    const seenLinks = new Set<string>();
    let linkMatch: RegExpExecArray | null;
    LINK_RE.lastIndex = 0;

    while ((linkMatch = LINK_RE.exec(file.content)) !== null) {
      const href = linkMatch[2];

      // Skip external URLs, anchors, and mailto
      if (
        href.startsWith('http://') ||
        href.startsWith('https://') ||
        href.startsWith('#') ||
        href.startsWith('mailto:')
      ) {
        continue;
      }

      // Strip anchor fragments from local links
      const cleanHref = href.split('#')[0];
      if (!cleanHref) continue;

      // Resolve relative to the file's directory, then normalize
      const resolved = path.posix.normalize(path.posix.join(fileDir, cleanHref));

      if (allPathSet.has(resolved)) {
        const targetFileId = generateId('File', resolved);

        // Skip if target file node doesn't exist
        if (!graph.getNode(targetFileId)) continue;

        // Dedup: skip if we've already linked this file pair
        const linkKey = `${fileNodeId}->${targetFileId}`;
        if (seenLinks.has(linkKey)) continue;
        seenLinks.add(linkKey);

        const relId = generateId('IMPORTS', linkKey);

        graph.addRelationship({
          id: relId,
          type: 'IMPORTS',
          sourceId: fileNodeId,
          targetId: targetFileId,
          confidence: 0.8,
          reason: 'markdown-link',
        });
        totalLinks++;
      }
    }
  }

  return { sections: totalSections, links: totalLinks };
};
