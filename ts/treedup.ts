import arrayFromAsyncIterable from "@xtjs/lib/js/arrayFromAsyncIterable";
import assertState from "@xtjs/lib/js/assertState";
import Dict from "@xtjs/lib/js/Dict";
import recursiveReaddir from "@xtjs/lib/js/recursiveReaddir";
import chalk from "chalk";
import { open, stat } from "fs/promises";
import ProgressBar from "progress";
import * as sacli from "sacli";

const READ_CHUNK_SIZE = 16384;

class MatchingFiles {
  readonly files: string[] = [];

  constructor(initFile: string) {
    this.files.push(initFile);
  }

  // NOTE: {@param file} must have same size as files in this.files.
  // If {@param subsequences} is provided, only those parts of the file
  // will be used for comparison, instead of the whole file.
  async addIfEquals(file: string, subsequences?: number[]) {
    const src = this.files[0];
    const [srcFd, fd] = await Promise.all([open(src, "r"), open(file, "r")]);
    const srcBuf = Buffer.allocUnsafe(READ_CHUNK_SIZE);
    const buf = Buffer.allocUnsafe(READ_CHUNK_SIZE);
    try {
      for (let i = 0; !subsequences || i < subsequences.length; i++) {
        const position = subsequences?.[i] ?? ([null] as const);
        const [srcRead, read] = await Promise.all([
          // @types/node are broken.
          // Also, use the object form with all args, as .read(buffer) doesn't seem to work even though it's specified in the documentation.
          srcFd.read({
            buffer: srcBuf,
            offset: 0,
            length: READ_CHUNK_SIZE,
            position,
          } as any),
          fd.read({
            buffer: buf,
            offset: 0,
            length: READ_CHUNK_SIZE,
            position,
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
  mode: "compare-full" | "compare-3",
  onTotal: (total: number) => void,
  onProgress: () => void
) => {
  const uniq = new Dict<number, MatchingFiles[]>();
  const allFiles = await arrayFromAsyncIterable(recursiveReaddir(rootDir));
  onTotal(allFiles.length);
  for (const path of allFiles) {
    // The tree must not be modified while treedup is running,
    // so we don't care about race conditions.
    const stats = await stat(path);
    assertState(stats.isFile());
    const sets = uniq.computeIfAbsent(stats.size, () => []);
    let matched = false;
    for (const s of sets) {
      let subsequences: number[] | undefined;
      switch (mode) {
        case "compare-3":
          subsequences = [
            0,
            (stats.size - READ_CHUNK_SIZE) / 2,
            stats.size - READ_CHUNK_SIZE,
          ];
          break;
        case "compare-full":
          subsequences = undefined;
          break;
        default:
          throw new Error(`Unknown mode: ${mode}`);
      }
      if (await s.addIfEquals(path, subsequences)) {
        matched = true;
        break;
      }
    }
    if (!matched) {
      sets.push(new MatchingFiles(path));
    }
    onProgress();
  }
  return [...uniq.values()].flatMap((s) =>
    s.filter((f) => f.files.length > 1).map((f) => f.files.sort())
  );
};

export default treedup;

if (require.main === module) {
  const cli = sacli.Command.new()
    .optional("dir", String)
    .optional("mode", String)
    .action(({ dir = process.cwd(), mode = "compare-full" }) => {
      let progress: ProgressBar;
      treedup(
        dir,
        mode as any,
        (total) =>
          (progress = new ProgressBar("[:bar] :percent", {
            clear: true,
            total,
            width: 50,
          })),
        () => progress.tick()
      )
        .then((sets) => {
          for (const set of sets) {
            console.log(chalk.green(set[0]));
            for (const path of set.slice(1)) {
              console.log(path);
            }
            console.log();
          }
        })
        .catch(console.error);
    });

  cli.eval(process.argv.slice(2));
}
