const BASE_URL_KABUPATEN =
  "https://sig.bps.go.id/rest-drop-down/getwilayah?level=kabupaten&parent=13";

const BASE_URL_KECAMATAN =
  "https://sig.bps.go.id/rest-drop-down/getwilayah?level=kecamatan&parent=1101";

const BASE_URL_DESA =
  "https://sig.bps.go.id/rest-bridging/getwilayah?level=desa&parent=1101010";

const BASE_URL_PROVINCE =
  "https://sig.bps.go.id/rest-bridging/getwilayah?level=provinsi&parent=0";

const BASE_URL = "https://sig.bps.go.id/rest-bridging/getwilayah";

const getWilayah = async (level) => {
  let zones = [];

  const provincesRes = await fetch(`${BASE_URL}?level=provinsi&parent=0`);

  const provinces = await provincesRes.json();

  console.log("PROVINCES", provinces.length);

  zones = [...zones, ...provinces.map((p) => ({ ...p, level: "provinsi" }))];
  console.log("ZONE", zones.length);

  const resKabupatens = await Promise.all(
    provinces.map(async (p) => {
      const res = await fetch(
        `${BASE_URL}?level=kabupaten&parent=${p.kode_bps}`
      );
      return await res.json();
    })
  );

  const kabupatens = resKabupatens.flat();

  console.log("KABUTAPEN", kabupatens.length);

  zones = [...zones, ...kabupatens.map((p) => ({ ...p, level: "kabupaten" }))];
  console.log("ZONE", zones.length);

  const resKecamatans = await Promise.all(
    kabupatens.map(async (k) => {
      const res = await fetch(
        `${BASE_URL}?level=kecamatan&parent=${k.kode_bps}`
      );
      return await res.json();
    })
  );

  const kecamatans = resKecamatans.flat();

  console.log("KECAMATAN", kecamatans.length);

  zones = [...zones, ...kecamatans.map((p) => ({ ...p, level: "kecamatan" }))];
  console.log("ZONE", zones.length);

  const INCREMENT = 400;

  const desaPromises = [];

  for (let i = 0; i < kecamatans.length; i += INCREMENT) {
    const resDesas = await Promise.all(
      kecamatans.slice(i, i + INCREMENT).map(async (k) => {
        const res = await fetch(`${BASE_URL}?level=desa&parent=${k.kode_bps}`);
        return await res.json();
      })
    );

    const desas = resDesas.flat();

    console.log(`DESA ${i}`, desas.length);

    zones = [...zones, ...desas.map((p) => ({ ...p, level: "desa" }))];
    console.log("ZONE", zones.length);
  }

  console.log("ZONE FINAL", zones.length);
};

getWilayah().then((val) => console.log(val));
