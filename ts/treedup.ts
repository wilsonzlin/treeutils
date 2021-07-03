import assertState from "@xtjs/lib/js/assertState";
import Dict from "@xtjs/lib/js/Dict";
import recursiveReaddir from "@xtjs/lib/js/recursiveReaddir";
import { open, stat } from "fs/promises";

class MatchingFiles {
  readonly files: string[] = [];

  constructor(initFile: string) {
    this.files.push(initFile);
  }

  // NOTE: {@param file} must have same size as files in this.files.
  async addIfEquals(file: string) {
    const src = this.files[0];
    const srcFd = await open(src, "r");
    const fd = await open(file, "r");
    const srcBuf = Buffer.alloc(8192);
    const buf = Buffer.alloc(8192);
    while (true) {
      const srcRead = await srcFd.read(srcBuf);
      const read = await fd.read(buf);
      assertState(srcRead.bytesRead === read.bytesRead);
      if (!srcRead.bytesRead) {
        break;
      }
      if (!srcBuf.equals(buf)) {
        return false;
      }
    }
    await srcFd.close();
    await fd.close();
    this.files.push(file);
    return true;
  }
}

const treedup = async (rootDir: string) => {
  const uniq = new Dict<number, MatchingFiles[]>();
  for await (const e of recursiveReaddir(rootDir)) {
    // The tree must not be modified while treedup is running,
    // so we don't care about race conditions.
    const stats = await stat(e);
    assertState(stats.isFile());
    const sets = uniq.computeIfAbsent(stats.size, () => []);
    let matched = false;
    for (const s of sets) {
      if (await s.addIfEquals(e)) {
        matched = true;
        break;
      }
    }
    if (!matched) {
      sets.push(new MatchingFiles(e));
    }
  }
  return [...uniq.values()].flatMap((s) =>
    s.filter((f) => f.files.length > 1).map((f) => f.files.sort())
  );
};

export default treedup;

if (require.main === module) {
  treedup(process.cwd())
    .then((res) => {
      for (const set of res) {
        for (const p of set) {
          console.log(p);
        }
        console.log();
      }
    })
    .catch(console.error);
}
