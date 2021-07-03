import assertState from "@xtjs/lib/js/assertState";
import Dict from "@xtjs/lib/js/Dict";
import PromiseQueue from "@xtjs/lib/js/PromiseQueue";
import recursiveReaddir from "@xtjs/lib/js/recursiveReaddir";
import { open, stat } from "fs/promises";
import * as os from "os";
import ProgressBar from "progress";

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
      const srcBuf = Buffer.alloc(8192);
      const buf = Buffer.alloc(8192);
      while (true) {
        const [srcRead, read] = await Promise.all([
          srcFd.read(srcBuf),
          fd.read(buf),
        ]);
        assertState(srcRead.bytesRead === read.bytesRead);
        if (!srcRead.bytesRead) {
          break;
        }
        if (!srcBuf.equals(buf)) {
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
  const queue = new PromiseQueue(os.cpus().length * 2);
  let processed = 0;
  let total = 0;
  const callOnProgress = () => onProgress({ processed, total });
  for await (const e of recursiveReaddir(rootDir)) {
    total++;
    callOnProgress();
    // The tree must not be modified while treedup is running,
    // so we don't care about race conditions.
    await queue
      .add(async () => {
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
      })
      .finally(() => {
        processed++;
        callOnProgress();
      });
  }
  return [...uniq.values()].flatMap((s) =>
    s.filter((f) => f.files.length > 1).map((f) => f.files.sort())
  );
};

export default treedup;

if (require.main === module) {
  const progress = new ProgressBar("[:bar] :percent", {
    clear: true,
    total: 100,
  });
  treedup(process.cwd(), (stats) =>
    progress.update((stats.processed / stats.total) * 100)
  )
    .finally(() => progress.terminate())
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
