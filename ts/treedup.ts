import arrayFromAsyncIterable from "@xtjs/lib/js/arrayFromAsyncIterable";
import assertState from "@xtjs/lib/js/assertState";
import Dict from "@xtjs/lib/js/Dict";
import recursiveReaddir from "@xtjs/lib/js/recursiveReaddir";
import { open, stat } from "fs/promises";
import ProgressBar from "progress";

const READ_CHUNK_SIZE = 16384;

class MatchingFiles {
  readonly files: string[] = [];

  constructor(initFile: string) {
    this.files.push(initFile);
  }

  // NOTE: {@param file} must have same size as files in this.files.
  async addIfEquals(file: string) {
    const src = this.files[0];
    const [srcFd, fd] = await Promise.all([open(src, "r"), open(file, "r")]);
    try {
      const srcBuf = Buffer.allocUnsafe(READ_CHUNK_SIZE);
      const buf = Buffer.allocUnsafe(READ_CHUNK_SIZE);
      while (true) {
        const [srcRead, read] = await Promise.all([
          // @types/node are broken.
          // Also, use the object form with all args, as .read(buffer) doesn't seem to work even though it's specified in the documentation.
          srcFd.read({
            buffer: srcBuf,
            offset: 0,
            length: READ_CHUNK_SIZE,
            position: null,
          } as any),
          fd.read({
            buffer: buf,
            offset: 0,
            length: READ_CHUNK_SIZE,
            position: null,
          } as any),
        ]);
        assertState(srcRead.bytesRead === read.bytesRead);
        const { bytesRead } = srcRead;
        if (!bytesRead) {
          break;
        }
        if (!srcBuf.slice(0, bytesRead).equals(buf.slice(0, bytesRead))) {
          return false;
        }
      }
      this.files.push(file);
      return true;
    } finally {
      await Promise.all([srcFd.close(), fd.close()]);
    }
  }
}

const treedup = async (
  rootDir: string,
  onProgress: (stats: { processed: number; total: number }) => void
) => {
  const uniq = new Dict<number, MatchingFiles[]>();
  let processed = 0;
  let total = 0;
  const callOnProgress = () => onProgress({ processed, total });
  const allFiles = await arrayFromAsyncIterable(recursiveReaddir(rootDir));
  total = allFiles.length;
  callOnProgress();
  for (const e of allFiles) {
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
    processed++;
    callOnProgress();
  }
  return [...uniq.values()].flatMap((s) =>
    s.filter((f) => f.files.length > 1).map((f) => f.files.sort())
  );
};

export default treedup;

if (require.main === module) {
  const progress = new ProgressBar("[:bar] :percent", {
    clear: true,
    total: 50,
  });
  treedup(process.cwd(), (stats) =>
    progress.update(stats.processed / stats.total)
  )
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
