interface TreeNode {
  children: Map<string, TreeNode>;
  isFile: boolean;
  name: string;
}

function createNode(name: string, isFile: boolean): TreeNode {
  return { name, children: new Map(), isFile };
}

/**
 * Builds an ASCII tree view from a list of relative file paths.
 *
 * @param rootName - Display name for the root directory (e.g. "my-app/")
 * @param filePaths - List of relative paths (e.g. ["package.json", "src/server.ts"])
 * @returns Array of lines representing the tree
 */
export function generateFileTree(rootName: string, filePaths: string[]): string[] {
  const root = createNode(rootName, false);

  // Build the tree structure
  for (const filePath of filePaths) {
    const parts = filePath.split("/").filter(Boolean);
    let current = root;

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      if (!part) {
        continue;
      }

      const isLast = i === parts.length - 1;

      if (!current.children.has(part)) {
        current.children.set(part, createNode(part, isLast));
      }

      const next = current.children.get(part);
      if (!next) {
        continue;
      }
      current = next;
    }
  }

  // Render the tree
  const lines: string[] = [];
  renderNode(root, "", true, lines);
  return lines;
}

function renderNode(node: TreeNode, prefix: string, isRoot: boolean, lines: string[]): void {
  if (isRoot) {
    lines.push(node.name.endsWith("/") ? node.name : `${node.name}/`);
  }

  const children = [...node.children.values()];

  for (let i = 0; i < children.length; i++) {
    const child = children[i];
    if (!child) {
      continue;
    }
    const isLast = i === children.length - 1;
    const connector = isLast ? "└── " : "├── ";
    const extension = child.isFile ? "" : "/";

    lines.push(`${prefix}${connector}${child.name}${extension}`);

    if (!child.isFile) {
      const newPrefix = prefix + (isLast ? "    " : "│   ");
      renderNode(child, newPrefix, false, lines);
    }
  }
}
