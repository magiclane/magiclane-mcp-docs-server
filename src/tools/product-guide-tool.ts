/**
 * SPDX-FileCopyrightText: 2026 Magic Lane International B.V. <info@magiclane.com>
 * SPDX-License-Identifier: Apache-2.0
 */
import type { CallToolResult, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { BaseTool, READ_ONLY_ANNOTATIONS } from './base-tool.js';
import { DOCS, LIMITS } from '../config/constants.js';
import { getDocument, sliceDocument } from '../docs/document.js';
import type { FetchedDocument } from '../docs/document.js';
import { loadIndex, peekIndex } from '../docs/docs-index.js';
import { errorMessage } from '../utils/errors.js';
import { isPermanentFailure } from '../utils/http-client.js';

interface GuidePage {
  title: string;
  /**
   * Where the page is published, newest location first. The Developer site
   * is replacing Map Studio's pages with the Magic Lane Studio guide, without
   * redirects: the guide serves whichever location the site has.
   */
  paths: [string, ...string[]];
}

interface Product {
  label: string;
  defaultSection: string;
  pages: Record<string, GuidePage>;
}

/** Official product guides, in reading order per product. */
const PRODUCTS: Record<string, Product> = {
  'mcp-server': {
    label: 'Magic Lane MCP Server (geospatial tools)',
    defaultSection: 'usage-guidelines',
    pages: {
      overview: {
        title: 'Magic Lane MCP Server — Introduction',
        paths: ['/docs/guides/mcp-server/introduction.md'],
      },
      'usage-guidelines': {
        title: 'Transform Your AI into a Geospatial Copilot — Usage Guidelines',
        paths: ['/docs/guides/mcp-server/usage-guidelines.md'],
      },
    },
  },
  'map-studio': {
    label: 'Magic Lane Studio (visual map-style editor, formerly Map Studio)',
    defaultSection: 'overview',
    pages: {
      overview: { title: 'Magic Lane Studio — Overview', paths: ['/docs/guides/map-studio.md'] },
      'create-a-map-style': {
        title: 'Create a Map Style',
        paths: [
          '/docs/guides/map-studio/getting-started/create-a-style.md',
          '/docs/guides/map-studio/create-a-map-style.md',
        ],
      },
      'customize-map-style': {
        title: 'Customize a Map Style',
        paths: ['/docs/guides/map-studio/tutorials/first-style.md', '/docs/guides/map-studio/customize-map-style.md'],
      },
      'download-style': {
        title: 'Download a Map Style and use it in an app',
        paths: [
          '/docs/guides/map-studio/getting-started/download-and-use.md',
          '/docs/guides/map-studio/download-style.md',
        ],
      },
    },
  },
};

const productIds = Object.keys(PRODUCTS) as [string, ...string[]];
const allSectionIds = [...new Set(Object.values(PRODUCTS).flatMap((p) => Object.keys(p.pages)))] as [
  string,
  ...string[],
];

const InputSchema = z.object({
  product: z.enum(productIds).describe('Which product guide to return.'),
  section: z
    .enum(['all', ...allSectionIds])
    .optional()
    .describe('Which guide section; omit for the product default, or "all" for every section in order.'),
});

type Input = z.infer<typeof InputSchema>;

/**
 * The pages the developer guides' index lists, if a copy is in memory (fresh
 * or stale; a due refresh runs on the side), else undefined — then the index
 * starts loading on the side too, and is not waited for: on a cold start the
 * guide pages are fetched at once instead of after the index.
 */
function publishedGuidePaths(): Set<string> | undefined {
  const developer = DOCS.sources[0]?.id as string;
  void loadIndex([developer]); // never rejects: failures are reported in its result
  const held = peekIndex(developer);
  return held ? new Set(held.map((e) => e.path)) : undefined;
}

/**
 * A guide page from the first of its locations that answers: the one the
 * index lists first, if it lists one, then the others in turn — so a page
 * that moved since the copy of the index in memory was made is still found
 * on the first call. Only a location the site does not have (404, or its
 * HTML shell) sends the guide on to the next one: when the site cannot be
 * reached or hangs, the other location is on the same site, and waiting for
 * it too would only double the wait.
 */
async function fetchGuidePage(page: GuidePage, listed: Set<string> | undefined): Promise<FetchedDocument> {
  const known = listed ? page.paths.filter((path) => listed.has(path)) : [];
  let failure: unknown;
  for (const path of [...known, ...page.paths.filter((p) => !known.includes(p))]) {
    try {
      return await getDocument(path);
    } catch (err) {
      if (!isPermanentFailure(err)) throw err;
      failure = err;
    }
  }
  throw failure;
}

export class ProductGuideTool extends BaseTool<typeof InputSchema> {
  readonly name = 'get_product_guide';
  readonly description =
    'Return the official documentation for a Magic Lane product. Products: "mcp-server" — the ' +
    'geospatial MCP giving AI agents location search, multi-modal routing, isochrone analysis, ' +
    'reverse geocoding, geofence management and map rendering (sections: overview, ' +
    'usage-guidelines; default usage-guidelines); "map-studio" — Magic Lane Studio (formerly Map ' +
    'Studio), the web-based visual editor for creating, testing and publishing custom map styles ' +
    '(sections: overview, create-a-map-style, ' +
    'customize-map-style, download-style; default overview). A finished style is published by ' +
    'downloading it as a .style file and loading that file in the app — there is no separate ' +
    'publish step, and download-style is the section that covers it. Use section "all" for the complete ' +
    'set in reading order. Use this for questions about the products themselves rather than the Maps SDKs.';
  readonly annotations: ToolAnnotations = {
    ...READ_ONLY_ANNOTATIONS,
    title: 'Get official Magic Lane product guides',
  };

  constructor() {
    super({ inputSchema: InputSchema });
  }

  async run(rawInput: unknown): Promise<CallToolResult> {
    const { product, section } = rawInput as Input;
    // `product` is constrained to the keys of PRODUCTS by the schema enum.
    const spec = PRODUCTS[product] as Product;
    const requested = section ?? spec.defaultSection;

    if (requested !== 'all' && !(requested in spec.pages)) {
      return this.errorResponse(
        `Section "${requested}" does not exist for product "${product}". Valid sections: ${Object.keys(spec.pages).join(
          ', '
        )}, or "all".`
      );
    }

    // Guarded above: for a non-"all" request the section exists in spec.pages.
    const selected = requested === 'all' ? Object.values(spec.pages) : [spec.pages[requested] as GuidePage];
    const listed = publishedGuidePaths();
    const results = await Promise.allSettled(selected.map((page) => fetchGuidePage(page, listed)));

    // Each section gets an equal share of the batch budget, never more than one page's cap.
    const allowance = Math.min(LIMITS.maxDocumentChars, Math.floor(LIMITS.maxBatchChars / selected.length));
    const parts = results.map((result, i) => {
      const page = selected[i] as GuidePage;
      if (result.status === 'fulfilled') {
        const doc = result.value;
        const slice = sliceDocument(doc.content, 0, allowance);
        const note = slice.hasMore
          ? `\n\n(Showing the first ${slice.end} of ${slice.total} characters; continue with read_doc, offset: ${slice.end}.)`
          : '';
        return `# ${page.title}\n\nSource: ${doc.url}${note}\n\n${slice.text}`;
      }
      return `# ${page.title}\n\nERROR: failed to fetch ${page.paths.join(' or ')} (${errorMessage(result.reason)})`;
    });

    const text = parts.join('\n\n---\n\n');
    const failures = results.filter((r) => r.status === 'rejected').length;
    return failures === results.length ? this.errorResponse(text) : this.textResponse(text);
  }
}
