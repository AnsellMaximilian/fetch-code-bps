# BPS region fetcher

Fetches every province, regency/city, district, and village exposed by the BPS
`getwilayah` endpoint into one CSV file.

## Run

```sh
npm install
npm run fetch
```

There are no third-party runtime dependencies; `npm install` only validates the
lockfile and is optional when a compatible Node.js version is already present.

The result is written to `wilayah-bps.csv`. The fetcher walks the complete
hierarchy rather than relying on hard-coded array ranges:

1. fetch all provinces;
2. fetch regencies/cities for every province;
3. fetch districts for every regency/city;
4. fetch villages for every district.

Only five requests run concurrently by default. Transient network errors,
HTTP 429 responses, and server errors are retried with exponential backoff.
Each successful response is cached in `.bps-cache`, so an interrupted run can
be started again without manually changing an index.

The output is replaced atomically only after all parent regions were visited,
responses were validated, and duplicate non-empty BPS codes were rejected. An
empty child response is retained as an explicit warning because the live API has
at least one such district. Use `--strict-empty` when an empty child response
should fail an audit run. A leaf village supplied by the API with only a Ministry
of Home Affairs (`kode_dagri`) code is retained and reported rather than
discarded.

Useful options:

```sh
# Ignore the resume cache and retrieve a current snapshot
npm run fetch -- --fresh

# Be gentler with the API
npm run fetch -- --concurrency 2

# Choose a different output file
npm run fetch -- --output data/wilayah.csv

# See every option
npm run fetch -- --help
```

## Add postal codes

Postal-code enrichment is optional because it comes from a separate service,
not BPS. Run:

```sh
npm run fetch:postcodes
```

This reuses the completed BPS cache, downloads the paginated postcode directory
from [CariKodePos.ID](https://carikodepos.id/api/docs), and joins villages using
the exact Ministry of Home Affairs code (`kode_dagri`). The resulting
`wilayah-bps.csv` has an additional `kode_pos` column. A value containing `|`
means the postcode source supplied multiple codes for the same village.

The compact postcode snapshot is cached at `.bps-cache/postcodes.json`. Refresh
it independently from the BPS cache with:

```sh
npm run fetch -- --with-postcodes --refresh-postcodes
```

A detailed `wilayah-bps.postcode-report.json` is also produced with match
coverage, unmatched villages, and villages with multiple postcodes. Paths can
be customized:

```sh
npm run fetch -- --with-postcodes \
  --postcode-cache data/postcodes.json \
  --postcode-report data/postcode-report.json \
  --output data/wilayah-with-postcodes.csv
```

The postcode service currently requires no API key, but it is still an external
third-party source. Keep the generated report with the CSV so its provenance and
snapshot time are explicit.

Run the offline test suite with:

```sh
npm test
```

The older `desa*.csv`, `uptokecamatan.csv`, and `combined_output.csv` files are
left untouched as historical output. New runs do not create or combine shards.
