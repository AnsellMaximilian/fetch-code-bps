"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const {
  collectAllWilayah,
  mapWithConcurrency,
  parseArgs,
  rowsToCsv,
} = require("../index");

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("collects every hierarchy branch with bounded concurrency and retries", async () => {
  const data = new Map([
    ["provinsi/0", [{ kode_bps: "11", nama_bps: "A" }, { kode_bps: "12", nama_bps: "B" }]],
    ["kabupaten/11", [{ kode_bps: "1101", nama_bps: "A1" }]],
    ["kabupaten/12", [{ kode_bps: "1201", nama_bps: "B1" }]],
    ["kecamatan/1101", [{ kode_bps: "1101010", nama_bps: "A11" }, { kode_bps: "1101020", nama_bps: "A12" }]],
    ["kecamatan/1201", [{ kode_bps: "1201010", nama_bps: "B11" }]],
    ["desa/1101010", [{ kode_bps: "1101010001", nama_bps: "A111" }]],
    ["desa/1101020", [{ kode_bps: "1101020001", nama_bps: "A121" }]],
    ["desa/1201010", [{ kode_bps: "1201010001", nama_bps: "B111" }]],
  ]);

  let activeRequests = 0;
  let maximumActiveRequests = 0;
  let transientFailures = 0;

  const fetchImpl = async (url) => {
    activeRequests += 1;
    maximumActiveRequests = Math.max(maximumActiveRequests, activeRequests);
    await new Promise((resolve) => setImmediate(resolve));

    const level = url.searchParams.get("level");
    const parent = url.searchParams.get("parent");
    const key = `${level}/${parent}`;
    activeRequests -= 1;

    if (key === "desa/1101020" && transientFailures === 0) {
      transientFailures += 1;
      return jsonResponse({ error: "busy" }, 503);
    }

    return jsonResponse(data.get(key));
  };

  const result = await collectAllWilayah({
    concurrency: 2,
    retries: 1,
    timeoutMs: 1_000,
    cacheDir: null,
    fetchImpl,
    sleep: async () => {},
    random: () => 0,
  });

  assert.deepEqual(result.counts, {
    provinsi: 2,
    kabupaten: 2,
    kecamatan: 3,
    desa: 3,
  });
  assert.equal(result.rows.length, 10);
  assert.equal(new Set(result.rows.map((row) => `${row.level}/${row.kode_bps}`)).size, 10);
  assert.equal(transientFailures, 1);
  assert.ok(maximumActiveRequests <= 2);
});

test("refuses to silently accept an empty child response", async () => {
  const fetchImpl = async (url) => {
    const level = url.searchParams.get("level");
    if (level === "provinsi") {
      return jsonResponse([{ kode_bps: "11", nama_bps: "A" }]);
    }
    return jsonResponse([]);
  };

  await assert.rejects(
    collectAllWilayah({
      concurrency: 1,
      retries: 0,
      cacheDir: null,
      allowEmpty: false,
      fetchImpl,
    }),
    /possibly incomplete file/,
  );
});

test("mapWithConcurrency preserves input order", async () => {
  const result = await mapWithConcurrency([3, 1, 2], 2, async (value) => value * 2);
  assert.deepEqual(result, [6, 2, 4]);
});

test("mapWithConcurrency stops scheduling work after the first failure", async () => {
  const started = [];

  await assert.rejects(
    mapWithConcurrency([1, 2, 3, 4, 5], 1, async (value) => {
      started.push(value);
      if (value === 2) throw new Error("stop");
      return value;
    }),
    /stop/,
  );

  assert.deepEqual(started, [1, 2]);
});

test("includes a desa that has only a kode_dagri", async () => {
  const data = new Map([
    ["provinsi/0", [{ kode_bps: "11" }]],
    ["kabupaten/11", [{ kode_bps: "1101" }]],
    ["kecamatan/1101", [{ kode_bps: "1101010" }]],
    [
      "desa/1101010",
      [
        {
          kode_bps: "",
          nama_bps: "",
          kode_dagri: "11.01.01.2001",
          nama_dagri: "ONLY DAGRI",
        },
      ],
    ],
  ]);

  const result = await collectAllWilayah({
    concurrency: 1,
    retries: 0,
    cacheDir: null,
    fetchImpl: async (url) => {
      const key = `${url.searchParams.get("level")}/${url.searchParams.get("parent")}`;
      return jsonResponse(data.get(key));
    },
  });

  assert.equal(result.rows.length, 4);
  assert.equal(result.missingBpsCodes.length, 1);
  assert.equal(result.missingBpsCodes[0].kode_dagri, "11.01.01.2001");
});

test("parses command-line controls", () => {
  assert.deepEqual(
    parseArgs(["--concurrency", "3", "--retries", "0", "--fresh", "--output", "all.csv"]),
    {
      concurrency: 3,
      retries: 0,
      timeoutMs: 30_000,
      output: "all.csv",
      cacheDir: ".bps-cache",
      fresh: true,
      allowEmpty: true,
    },
  );
});

test("reports an empty leaf parent without dropping the parent", async () => {
  const data = new Map([
    ["provinsi/0", [{ kode_bps: "11" }]],
    ["kabupaten/11", [{ kode_bps: "1101" }]],
    ["kecamatan/1101", [{ kode_bps: "1101010", nama_bps: "EMPTY" }]],
    ["desa/1101010", []],
  ]);

  const result = await collectAllWilayah({
    concurrency: 1,
    retries: 0,
    cacheDir: null,
    fetchImpl: async (url) => {
      const key = `${url.searchParams.get("level")}/${url.searchParams.get("parent")}`;
      return jsonResponse(data.get(key));
    },
  });

  assert.equal(result.rows.length, 3);
  assert.equal(result.emptyParents.length, 1);
  assert.equal(result.emptyParents[0].parent.kode_bps, "1101010");
});

test("escapes commas, quotes, and newlines in CSV output", () => {
  const csv = rowsToCsv([
    { kode_bps: "1", nama_bps: 'A, "quoted" place', level: "desa" },
    { kode_bps: "2", nama_bps: "two\nlines", level: "desa" },
  ]);

  assert.equal(
    csv,
    'kode_bps,nama_bps,level\n1,"A, ""quoted"" place",desa\n2,"two\nlines",desa',
  );
});

test("resumes a second run entirely from successful cached responses", async () => {
  const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), "bps-fetch-test-"));
  const data = new Map([
    ["provinsi/0", [{ kode_bps: "11" }]],
    ["kabupaten/11", [{ kode_bps: "1101" }]],
    ["kecamatan/1101", [{ kode_bps: "1101010" }]],
    ["desa/1101010", [{ kode_bps: "1101010001" }]],
  ]);

  try {
    await collectAllWilayah({
      concurrency: 2,
      retries: 0,
      cacheDir,
      fetchImpl: async (url) => {
        const key = `${url.searchParams.get("level")}/${url.searchParams.get("parent")}`;
        return jsonResponse(data.get(key));
      },
    });

    const resumed = await collectAllWilayah({
      concurrency: 2,
      retries: 0,
      cacheDir,
      fetchImpl: async () => {
        throw new Error("the network should not be used on resume");
      },
    });

    assert.equal(resumed.rows.length, 4);
  } finally {
    await fs.rm(cacheDir, { recursive: true, force: true });
  }
});
