"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");

const BASE_URL = "https://sig.bps.go.id/rest-bridging/getwilayah";
const LEVELS = ["provinsi", "kabupaten", "kecamatan", "desa"];

const DEFAULT_OPTIONS = {
  concurrency: 5,
  retries: 5,
  timeoutMs: 30_000,
  output: "wilayah-bps.csv",
  cacheDir: ".bps-cache",
  fresh: false,
  allowEmpty: true,
};

class HttpError extends Error {
  constructor(message, status, retryAfterMs = 0) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

function parsePositiveInteger(value, optionName, { allowZero = false } = {}) {
  const parsed = Number(value);
  const minimum = allowZero ? 0 : 1;

  if (!Number.isInteger(parsed) || parsed < minimum) {
    throw new Error(`${optionName} must be an integer >= ${minimum}`);
  }

  return parsed;
}

function parseArgs(argv) {
  const options = { ...DEFAULT_OPTIONS };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const nextValue = () => {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error(`${argument} requires a value`);
      }
      index += 1;
      return value;
    };

    switch (argument) {
      case "--concurrency":
        options.concurrency = parsePositiveInteger(nextValue(), argument);
        break;
      case "--retries":
        options.retries = parsePositiveInteger(nextValue(), argument, {
          allowZero: true,
        });
        break;
      case "--timeout":
        options.timeoutMs = parsePositiveInteger(nextValue(), argument);
        break;
      case "--output":
        options.output = nextValue();
        break;
      case "--cache-dir":
        options.cacheDir = nextValue();
        break;
      case "--fresh":
        options.fresh = true;
        break;
      case "--allow-empty":
        options.allowEmpty = true;
        break;
      case "--strict-empty":
        options.allowEmpty = false;
        break;
      case "--help":
        options.help = true;
        break;
      default:
        throw new Error(`Unknown option: ${argument}`);
    }
  }

  return options;
}

function usage() {
  return `Usage: npm run fetch -- [options]

Options:
  --concurrency <number>  Maximum simultaneous API requests (default: 5)
  --retries <number>      Retries for transient failures (default: 5)
  --timeout <ms>          Timeout for each request (default: 30000)
  --output <path>         Final CSV path (default: wilayah-bps.csv)
  --cache-dir <path>      Resume cache directory (default: .bps-cache)
  --fresh                 Ignore cached responses and fetch everything again
  --strict-empty          Fail if a parent has no children instead of reporting it
  --help                  Show this help`;
}

function retryDelay(attempt, retryAfterMs, random = Math.random) {
  if (retryAfterMs > 0) return retryAfterMs;
  const exponentialDelay = Math.min(1_000 * 2 ** attempt, 15_000);
  return exponentialDelay + Math.floor(random() * 250);
}

function retryAfterInMilliseconds(value) {
  if (!value) return 0;

  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1_000);

  const date = Date.parse(value);
  return Number.isNaN(date) ? 0 : Math.max(0, date - Date.now());
}

function isRetryable(error) {
  if (!(error instanceof HttpError)) return true;
  return error.status === 429 || error.status >= 500;
}

function validateRows(rows, level, parentCode) {
  if (!Array.isArray(rows)) {
    throw new Error(
      `Invalid ${level} response for parent ${parentCode}: expected an array`,
    );
  }

  for (const [index, row] of rows.entries()) {
    const hasBpsCode = Boolean(String(row?.kode_bps || "").trim());
    const hasDagriCode = Boolean(String(row?.kode_dagri || "").trim());
    const validLeafWithoutBpsCode = level === "desa" && hasDagriCode;

    if (
      !row ||
      typeof row !== "object" ||
      (!hasBpsCode && !validLeafWithoutBpsCode)
    ) {
      throw new Error(
        `Invalid ${level} item ${index} for parent ${parentCode}: ` +
          "missing the code required to traverse or identify it",
      );
    }
  }

  return rows;
}

async function fetchRows(level, parentCode, options) {
  const {
    fetchImpl = fetch,
    retries,
    timeoutMs,
    sleep = (milliseconds) =>
      new Promise((resolve) => setTimeout(resolve, milliseconds)),
    random = Math.random,
  } = options;

  const url = new URL(BASE_URL);
  url.searchParams.set("level", level);
  url.searchParams.set("parent", parentCode);

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetchImpl(url, {
        headers: { accept: "application/json" },
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new HttpError(
          `BPS returned HTTP ${response.status} for ${level}/${parentCode}`,
          response.status,
          retryAfterInMilliseconds(response.headers.get("retry-after")),
        );
      }

      const rows = await response.json();
      return validateRows(rows, level, parentCode);
    } catch (error) {
      const canRetry = attempt < retries && isRetryable(error);
      if (!canRetry) {
        throw new Error(
          `Could not fetch ${level} for parent ${parentCode} after ${attempt + 1} attempt(s): ${error.message}`,
          { cause: error },
        );
      }

      await sleep(retryDelay(attempt, error.retryAfterMs, random));
    } finally {
      clearTimeout(timeout);
    }
  }

  throw new Error(`Could not fetch ${level} for parent ${parentCode}`);
}

function cachePath(cacheDir, level, parentCode) {
  return path.join(cacheDir, level, `${parentCode}.json`);
}

async function readCache(cacheDir, level, parentCode) {
  try {
    const content = await fs.readFile(cachePath(cacheDir, level, parentCode), "utf8");
    return validateRows(JSON.parse(content), level, parentCode);
  } catch (error) {
    if (error.code === "ENOENT" || error instanceof SyntaxError) return null;
    throw error;
  }
}

async function writeCache(cacheDir, level, parentCode, rows) {
  const destination = cachePath(cacheDir, level, parentCode);
  const temporary = `${destination}.${process.pid}.tmp`;
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.writeFile(temporary, JSON.stringify(rows), "utf8");
  await fs.rename(temporary, destination);
}

async function getRows(level, parentCode, options) {
  if (options.cacheDir && !options.fresh) {
    const cached = await readCache(options.cacheDir, level, parentCode);
    if (cached) return { rows: cached, cached: true };
  }

  const rows = await fetchRows(level, parentCode, options);
  if (options.cacheDir) {
    await writeCache(options.cacheDir, level, parentCode, rows);
  }
  return { rows, cached: false };
}

async function mapWithConcurrency(items, concurrency, mapper) {
  const results = new Array(items.length);
  let nextIndex = 0;
  let fatalError = null;

  async function worker() {
    while (!fatalError && nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      try {
        results[index] = await mapper(items[index], index);
      } catch (error) {
        fatalError ||= error;
      }
    }
  }

  const workerCount = Math.min(concurrency, items.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  if (fatalError) throw fatalError;
  return results;
}

function assertUniqueCodes(rows, level) {
  const seen = new Set();

  for (const row of rows) {
    const code = String(row.kode_bps || "").trim();
    if (!code) continue;
    if (seen.has(code)) {
      throw new Error(`Duplicate ${level} kode_bps returned by BPS: ${code}`);
    }
    seen.add(code);
  }
}

async function fetchLevel(level, parents, options) {
  let completed = 0;
  let cached = 0;
  const progress = options.progress || (() => {});

  const responses = await mapWithConcurrency(
    parents,
    options.concurrency,
    async (parent) => {
      const result = await getRows(level, parent.kode_bps, options);
      if (result.cached) cached += 1;

      if (result.rows.length === 0 && !options.allowEmpty) {
        throw new Error(
          `BPS returned no ${level} rows for parent ${parent.kode_bps}. ` +
            "Refusing to produce a possibly incomplete file; use --allow-empty only if this is expected.",
        );
      }

      if (result.rows.length === 0) {
        options.onEmpty?.({ level, parent });
      }

      completed += 1;
      progress({ level, completed, total: parents.length, cached });
      return result.rows;
    },
  );

  const rows = responses.flat();
  assertUniqueCodes(rows, level);
  return rows.map((row) => ({ ...row, level }));
}

async function collectAllWilayah(options = {}) {
  const resolved = { ...DEFAULT_OPTIONS, ...options };
  const root = [{ kode_bps: "0" }];
  const levels = {};
  const emptyParents = [];
  const onEmpty = resolved.onEmpty;
  resolved.onEmpty = (entry) => {
    emptyParents.push(entry);
    onEmpty?.(entry);
  };

  levels.provinsi = await fetchLevel("provinsi", root, {
    ...resolved,
    allowEmpty: false,
  });
  levels.kabupaten = await fetchLevel("kabupaten", levels.provinsi, resolved);
  levels.kecamatan = await fetchLevel("kecamatan", levels.kabupaten, resolved);
  levels.desa = await fetchLevel("desa", levels.kecamatan, resolved);

  return {
    rows: LEVELS.flatMap((level) => levels[level]),
    counts: Object.fromEntries(
      LEVELS.map((level) => [level, levels[level].length]),
    ),
    missingBpsCodes: levels.desa.filter(
      (row) => !String(row.kode_bps || "").trim(),
    ),
    emptyParents,
  };
}

function csvCell(value) {
  if (value === null || value === undefined) return "";
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function rowsToCsv(rows) {
  if (rows.length === 0) throw new Error("Cannot write a CSV with no rows");

  const headers = [...new Set(rows.flatMap((row) => Object.keys(row)))];
  const lines = [
    headers.map(csvCell).join(","),
    ...rows.map((row) => headers.map((header) => csvCell(row[header])).join(",")),
  ];
  return lines.join("\n");
}

async function writeCsvAtomic(output, rows) {
  const destination = path.resolve(output);
  const temporary = `${destination}.${process.pid}.tmp`;
  await fs.mkdir(path.dirname(destination), { recursive: true });

  try {
    const csv = rowsToCsv(rows);
    await fs.writeFile(temporary, csv, "utf8");
    await fs.rename(temporary, destination);
  } catch (error) {
    await fs.rm(temporary, { force: true });
    throw error;
  }

  return destination;
}

function consoleProgress({ level, completed, total, cached }) {
  if (completed === total || completed % 100 === 0) {
    const cacheMessage = cached ? ` (${cached} from cache)` : "";
    console.log(`${level}: ${completed}/${total} parents${cacheMessage}`);
  }
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    console.log(usage());
    return;
  }

  console.log(
    `Fetching all BPS regions with concurrency=${options.concurrency}` +
      (options.fresh ? " (fresh fetch)" : " (resume cache enabled)"),
  );

  const { rows, counts, missingBpsCodes, emptyParents } =
    await collectAllWilayah({
    ...options,
    progress: consoleProgress,
  });
  const destination = await writeCsvAtomic(options.output, rows);

  console.log("Validated counts:", counts);
  if (missingBpsCodes.length > 0) {
    console.warn(
      `Included ${missingBpsCodes.length} desa row(s) for which the BPS API ` +
        "supplied kode_dagri but no kode_bps:",
      missingBpsCodes.map((row) => row.nama_dagri || row.nama_bps),
    );
  }
  if (emptyParents.length > 0) {
    console.warn(
      `The BPS API supplied no children for ${emptyParents.length} parent row(s):`,
      emptyParents.map(({ parent }) => `${parent.kode_bps} (${parent.nama_bps})`),
    );
  }
  console.log(`Wrote ${rows.length} regions to ${destination}`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = {
  DEFAULT_OPTIONS,
  HttpError,
  collectAllWilayah,
  fetchRows,
  mapWithConcurrency,
  parseArgs,
  rowsToCsv,
  writeCsvAtomic,
};
