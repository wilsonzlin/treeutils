import maybeFileStats from "@xtjs/lib/js/maybeFileStats";
import propertyComparator from "@xtjs/lib/js/propertyComparator";
import { createHash } from "crypto";
import { createReadStream } from "fs";
import { lstat, open, readdir } from "fs/promises";
import { join } from "path";
import { pipeline } from "stream/promises";

const BUFSIZE = 8 * 1024;
const PADDING = 2;

enum Diff {
  REMOVED = "\x1b[91m",
  ADDED = "\x1b[92m",
  CHANGED = "\x1b[93m",
  RENAMED = "\x1b[96m",
}

class TreeFileNode {
  constructor(readonly diff: Diff, readonly renamedFrom?: string) {}
}

class TreeDirNode {
  private readonly dirs = new Map<string, TreeDirNode>();
  private readonly files = new Map<string, TreeFileNode>();

  children() {
    return [...this.dirs, ...this.files].sort(propertyComparator(0));
  }

  addFile(name: string, file: TreeFileNode) {
    this.files.set(name, file);
  }

  removeFile(name: string) {
    this.files.delete(name);
  }

  createDir(name: string) {
    const newDir = new TreeDirNode();
    this.dirs.set(name, newDir);
    return newDir;
  }

  get length() {
    return this.dirs.size + this.files.size;
  }

  prune() {
    const toDelete = [];
    for (const [name, node] of this.dirs) {
      node.prune();
      if (!node.length) {
        toDelete.push(name);
      }
    }
    for (const name of toDelete) {
      this.dirs.delete(name);
    }
  }
}

const equalFiles = async (f1: string, f2: string) => {
  const [fp1, fp2] = await Promise.all([open(f1, "r"), open(f2, "r")]);
  const b1 = Buffer.allocUnsafe(BUFSIZE);
  const b2 = Buffer.allocUnsafe(BUFSIZE);
  while (true) {
    const [r1, r2] = await Promise.all([
      fp1.read({
        buffer: b1,
        offset: 0,
        length: BUFSIZE,
      } as any),
      fp2.read({
        buffer: b2,
        offset: 0,
        length: BUFSIZE,
      } as any),
    ]);
    if (!b1.slice(0, r1.bytesRead).equals(b2.slice(0, r2.bytesRead))) {
      return false;
    }
    if (!r1.bytesRead) {
      return true;
    }
  }
};

const hashFile = async (file: string) => {
  const hash = createHash("sha1");
  await pipeline(createReadStream(file), hash);
  return hash.digest("base64");
};

const maybeLstat = async (p: string) => {
  try {
    return await lstat(p);
  } catch (e) {
    if (e.code == "ENOENT") {
      return undefined;
    }
    throw e;
  }
};

const calc = async (tree: TreeDirNode, dirA: string, dirB: string) => {
  const B = new Set(await readdir(dirB));

  // hash => file.
  const hashes = new Map<string, string>();

  for (const ent of await readdir(dirA)) {
    let diff: Diff | undefined = undefined;
    const pathA = join(dirA, ent);
    const pathB = join(dirB, ent);
    const [a, b] = await Promise.all([lstat(pathA), maybeLstat(pathB)]);
    if (!b) {
      diff = Diff.REMOVED;
      if (a?.isFile()) {
        hashes.set(await hashFile(pathA), ent);
      }
    } else {
      B.delete(ent);
      if ((a.mode & 0xf000) != (b.mode & 0xf000)) {
        // Files are not of the same type.
        diff = Diff.CHANGED;
      } else if (a.isDirectory()) {
        // File is a directory, so recursively scan it.
        await calc(tree.createDir(ent), pathA, pathB);
      } else if (!a.isFile()) {
        // At least one file is not a file.
        diff = Diff.CHANGED;
      } else if (a.size != b.size) {
        // Sizes are different.
        diff = Diff.CHANGED;
      } else if (!(await equalFiles(pathA, pathB))) {
        // File contents are different.
        diff = Diff.CHANGED;
      }
    }
    if (diff != undefined) {
      tree.addFile(ent, new TreeFileNode(diff));
    }
  }

  for (const ent of B) {
    const p = join(dirB, ent);
    let renamed_from: string | undefined = undefined;
    if (await maybeFileStats(p)) {
      const h = await hashFile(p);
      if (hashes.has(h)) {
        renamed_from = hashes.get(h)!;
        tree.removeFile(renamed_from);
        hashes.delete(h);
      }
    }
    tree.addFile(
      ent,
      new TreeFileNode(
        renamed_from != undefined ? Diff.RENAMED : Diff.ADDED,
        renamed_from
      )
    );
  }
};

const show = (tree: TreeDirNode, level = 0, prefix = "") => {
  const children = tree.children();
  const amount = children.length;
  for (const [i, [name, node]] of children.entries()) {
    const last = i == amount - 1;
    const left_align = prefix + (last ? "└" : "├") + "─".repeat(PADDING);
    if (node instanceof TreeFileNode) {
      if (node.diff == Diff.RENAMED) {
        console.log(
          `${left_align}${node.diff}{${name} => ${node.renamedFrom}}\x1b[0m`
        );
      } else {
        console.log(`${left_align}${node.diff}${name}\x1b[0m`);
      }
    } else {
      console.log(`${left_align}\x1b[1m${name}\x1b[0m`);
      const subprefix = (last ? " " : "│") + " ".repeat(PADDING);
      show(node, level + 1, (prefix = prefix + subprefix));
    }
  }
};

if (require.main === module) {
  (async () => {
    const dirA = process.argv[2];
    const dirB = process.argv[3];
    const tree = new TreeDirNode();
    await calc(tree, dirA, dirB);
    tree.prune();
    console.log(`--- ${dirA}`);
    console.log(`+++ ${dirB}`);
    show(tree);
  })().catch(console.error);
}
