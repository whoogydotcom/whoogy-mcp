type FigmaLinkTarget = {
  rawUrl: string;
  fileKey: string;
  nodeId: string | null;
};

/** Parses a Figma file/frame URL into a fileKey (+ optional nodeId). */
export function parseFigmaLink(rawUrl: string): FigmaLinkTarget {
  const url = new URL(rawUrl);
  const match = url.pathname.match(/^\/(?:design|file)\/([^/]+)/i);

  if (!match?.[1]) {
    throw new Error("Could not parse a Figma file key from the provided link.");
  }

  const rawNodeId = url.searchParams.get("node-id");
  const nodeId = rawNodeId ? rawNodeId.replace(/-/g, ":") : null;

  return {
    rawUrl,
    fileKey: match[1],
    nodeId,
  };
}
